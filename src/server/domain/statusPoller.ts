import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import {
  getActiveWithdrawalJobs,
  updateWithdrawalJob,
  incrementPollCount,
  addPendingAmount,
} from '../db/repositories.js';
import type { KrakenRestClient } from '../kraken/restClient.js';
import type { PollingConfig } from '../config/schema.js';
import type { WithdrawalJob, KrakenWithdrawStatus, WithdrawalStatus } from './types.js';

const logger = createChildLogger('status-poller');

export interface StatusPollerOptions {
  krakenClient: KrakenRestClient;
  pollingConfig: PollingConfig;
}

export interface StatusPollerEvents {
  jobComplete: (job: WithdrawalJob, txid?: string) => void;
  jobFailed: (job: WithdrawalJob, error: string) => void;
  jobHeld: (job: WithdrawalJob) => void;
  jobStuck: (job: WithdrawalJob, durationMs: number) => void;
}

/**
 * Maps Kraken status strings to our internal status
 */
function mapKrakenStatus(krakenStatus: string): WithdrawalStatus {
  switch (krakenStatus.toLowerCase()) {
    case 'initial':
    case 'pending':
      return 'pending';
    case 'settled':
    case 'success':
      return 'complete';
    case 'failure':
      return 'failed';
    case 'on hold':
      return 'held';
    case 'cancel pending':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export class StatusPoller extends EventEmitter {
  private krakenClient: KrakenRestClient;
  private pollingConfig: PollingConfig;

  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPollTime = 0;

  constructor(options: StatusPollerOptions) {
    super();
    this.krakenClient = options.krakenClient;
    this.pollingConfig = options.pollingConfig;
  }

  /**
   * Start the status polling loop
   */
  start(): void {
    if (this.running) {
      return;
    }

    logger.info('Starting status poller');
    this.running = true;
    this.schedulePoll();
  }

  /**
   * Stop the status polling loop
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    logger.info('Stopping status poller');
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Update Kraken client
   */
  updateKrakenClient(client: KrakenRestClient): void {
    this.krakenClient = client;
  }

  /**
   * Calculate the next poll delay based on active jobs
   */
  private calculatePollDelay(jobs: WithdrawalJob[]): number {
    if (jobs.length === 0) {
      // No active jobs, poll less frequently
      return this.pollingConfig.withdrawStatus.slowSeconds * 1000;
    }

    const config = this.pollingConfig.withdrawStatus;
    const now = Date.now();

    // Find the newest job
    const newestJob = jobs.reduce(
      (newest, job) => (job.createdAt > newest.createdAt ? job : newest),
      jobs[0]
    );

    const age = now - newestJob.createdAt;
    const ageSeconds = age / 1000;

    // Determine poll rate based on job age
    // Fast polling: first N polls
    const fastDuration = config.fastSeconds * config.fastCount;
    if (ageSeconds < fastDuration) {
      return config.fastSeconds * 1000;
    }

    // Medium polling: next N polls
    const mediumDuration = config.mediumSeconds * config.mediumCount;
    if (ageSeconds < fastDuration + mediumDuration) {
      return config.mediumSeconds * 1000;
    }

    // Slow polling
    return config.slowSeconds * 1000;
  }

  /**
   * Schedule the next poll
   */
  private schedulePoll(): void {
    if (!this.running) return;

    const jobs = getActiveWithdrawalJobs();
    const delay = this.calculatePollDelay(jobs);

    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  /**
   * Run one poll cycle - fetch all statuses and update jobs
   */
  private async poll(): Promise<void> {
    const now = Date.now();
    this.lastPollTime = now;

    try {
      const jobs = getActiveWithdrawalJobs();

      if (jobs.length === 0) {
        logger.debug('No active jobs to poll');
        this.schedulePoll();
        return;
      }

      logger.debug({ jobCount: jobs.length }, 'Polling withdrawal status');

      // Fetch status from Kraken (one call for all jobs)
      const statuses = await this.krakenClient.getWithdrawStatus();

      // Build lookup map by refid
      const statusMap = new Map<string, KrakenWithdrawStatus>();
      for (const status of statuses) {
        statusMap.set(status.refid, status);
      }

      // Update each job
      for (const job of jobs) {
        await this.updateJobStatus(job, statusMap, now);
      }
    } catch (error) {
      logger.error({ error }, 'Status poll failed');
    }

    this.schedulePoll();
  }

  /**
   * Update a single job's status based on Kraken response
   */
  private async updateJobStatus(
    job: WithdrawalJob,
    statusMap: Map<string, KrakenWithdrawStatus>,
    now: number
  ): Promise<void> {
    // Find matching status by Kraken reference
    const krakenStatus = job.krakenRef ? statusMap.get(job.krakenRef) : null;

    // Increment poll count
    incrementPollCount(job.id);

    if (!krakenStatus) {
      // Status not found - might be too new or already processed
      logger.debug({ jobId: job.id, krakenRef: job.krakenRef }, 'Status not found');

      // Check if stuck
      this.checkStuck(job, now);
      return;
    }

    const newStatus = mapKrakenStatus(krakenStatus.status);

    // No change
    if (newStatus === job.status) {
      this.checkStuck(job, now);
      return;
    }

    logger.info(
      {
        jobId: job.id,
        oldStatus: job.status,
        newStatus,
        txid: krakenStatus.txid,
      },
      'Job status updated'
    );

    // Update job in database
    updateWithdrawalJob(job.id, {
      status: newStatus,
      txid: krakenStatus.txid,
    });

    // Emit events based on new status
    switch (newStatus) {
      case 'complete':
        this.emit('jobComplete', { ...job, status: newStatus }, krakenStatus.txid);
        break;

      case 'failed':
        this.handleJobFailure(job, krakenStatus.statusProp || 'Unknown failure');
        break;

      case 'held':
        this.emit('jobHeld', { ...job, status: newStatus });
        break;

      case 'cancelled':
        // Return amount to pending
        addPendingAmount(job.asset, job.amount);
        logger.info({ jobId: job.id, amount: job.amount }, 'Cancelled withdrawal returned to pending');
        break;
    }
  }

  /**
   * Handle a failed withdrawal
   */
  private handleJobFailure(job: WithdrawalJob, error: string): void {
    updateWithdrawalJob(job.id, {
      status: 'failed',
      lastError: error,
    });

    // Optionally return amount to pending for retry
    // Note: Be careful about this - some failures shouldn't be retried
    // For now, we don't auto-return on failure - requires manual intervention

    this.emit('jobFailed', { ...job, status: 'failed' }, error);
  }

  /**
   * Check if a job is stuck (taking too long)
   */
  private checkStuck(job: WithdrawalJob, now: number): void {
    const stuckThresholdMs = this.pollingConfig.withdrawStatus.stuckMinutes * 60 * 1000;
    const age = now - job.createdAt;

    if (age > stuckThresholdMs && job.status !== 'complete') {
      logger.warn(
        {
          jobId: job.id,
          asset: job.asset,
          age: Math.floor(age / 60000) + 'm',
        },
        'Withdrawal appears stuck'
      );

      this.emit('jobStuck', job, age);
    }
  }

  /**
   * Force an immediate poll
   */
  pollNow(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.poll();
  }

  /**
   * Get time since last poll
   */
  getTimeSinceLastPoll(): number {
    return Date.now() - this.lastPollTime;
  }
}
