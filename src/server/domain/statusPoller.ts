import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import {
  getActiveWithdrawalJobs,
  updateWithdrawalJob,
  incrementPollCount,
  addPendingAmount,
} from '../db/repositories.js';
import { getClientPool } from '../exchanges/clientPool.js';
import type { ExchangeRestClient, WithdrawStatusRecord } from '../exchanges/types.js';
import type { PollingConfig } from '../config/schema.js';
import type { WithdrawalJob, WithdrawalStatus, ExchangeId } from './types.js';

const logger = createChildLogger('status-poller');

export interface StatusPollerOptions {
  pollingConfig: PollingConfig;
  enabledExchanges: ExchangeId[];
}

export interface StatusPollerEvents {
  jobComplete: (job: WithdrawalJob, txid?: string) => void;
  jobFailed: (job: WithdrawalJob, error: string) => void;
  jobHeld: (job: WithdrawalJob) => void;
  jobStuck: (job: WithdrawalJob, durationMs: number) => void;
}

/**
 * Maps exchange status strings to our internal status
 */
function mapStatus(exchangeStatus: string): WithdrawalStatus {
  switch (exchangeStatus.toLowerCase()) {
    case 'initial':
    case 'pending':
      return 'pending';
    case 'processing':
      return 'pending';
    case 'settled':
    case 'success':
    case 'complete':
      return 'complete';
    case 'failure':
    case 'failed':
      return 'failed';
    case 'on hold':
    case 'held':
      return 'held';
    case 'cancel pending':
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export class StatusPoller extends EventEmitter {
  private pollingConfig: PollingConfig;
  private enabledExchanges: ExchangeId[];

  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPollTime = 0;

  constructor(options: StatusPollerOptions) {
    super();
    this.pollingConfig = options.pollingConfig;
    this.enabledExchanges = options.enabledExchanges;
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
   * @param silent - If true, don't log (used during process exit when logger may be unavailable)
   */
  stop(silent = false): void {
    if (!this.running) {
      return;
    }

    if (!silent) {
      logger.info('Stopping status poller');
    }
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Update enabled exchanges
   */
  updateEnabledExchanges(exchanges: ExchangeId[]): void {
    this.enabledExchanges = exchanges;
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
    // Check if stopped (handles race condition during shutdown)
    if (!this.running) {
      return;
    }

    const now = Date.now();
    this.lastPollTime = now;

    try {
      // Get all active jobs
      const allJobs = getActiveWithdrawalJobs();

      if (allJobs.length === 0) {
        logger.debug('No active jobs to poll');
        this.schedulePoll();
        return;
      }

      // Group jobs by exchange
      const jobsByExchange = new Map<ExchangeId, WithdrawalJob[]>();
      for (const job of allJobs) {
        const exchange = job.exchange;
        if (!jobsByExchange.has(exchange)) {
          jobsByExchange.set(exchange, []);
        }
        jobsByExchange.get(exchange)!.push(job);
      }

      // Poll each exchange
      for (const [exchange, jobs] of jobsByExchange) {
        await this.pollExchange(exchange, jobs, now);
      }
    } catch (error) {
      logger.error({ error }, 'Status poll failed');
    }

    this.schedulePoll();
  }

  /**
   * Poll status for jobs on a specific exchange
   */
  private async pollExchange(
    exchange: ExchangeId,
    jobs: WithdrawalJob[],
    now: number
  ): Promise<void> {
    logger.debug({ exchange, jobCount: jobs.length }, 'Polling withdrawal status');

    const pool = getClientPool(exchange);
    const selection = pool.selectBestKey();

    if (!selection) {
      logger.warn({ exchange }, 'No available API keys to poll status');
      return;
    }

    try {
      // Fetch status from exchange (one call for all jobs)
      const statuses = await selection.client.getWithdrawStatus();
      pool.recordUsage(selection.keyId, 1);

      // Build lookup map by refid
      const statusMap = new Map<string, WithdrawStatusRecord>();
      for (const status of statuses) {
        statusMap.set(status.refId, status);
      }

      // Update each job
      for (const job of jobs) {
        await this.updateJobStatus(job, statusMap, now);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      pool.handleError(selection.keyId, errorMsg);
      logger.error({ exchange, error: errorMsg }, 'Failed to poll status');
    }
  }

  /**
   * Update a single job's status based on exchange response
   */
  private async updateJobStatus(
    job: WithdrawalJob,
    statusMap: Map<string, WithdrawStatusRecord>,
    now: number
  ): Promise<void> {
    // Find matching status by exchange reference
    const exchangeStatus = job.exchangeRef ? statusMap.get(job.exchangeRef) : null;

    // Increment poll count
    incrementPollCount(job.id);

    if (!exchangeStatus) {
      // Status not found - might be too new or already processed
      logger.debug({ jobId: job.id, exchangeRef: job.exchangeRef }, 'Status not found');

      // Check if stuck
      this.checkStuck(job, now);
      return;
    }

    const newStatus = mapStatus(exchangeStatus.status);

    // No change
    if (newStatus === job.status) {
      this.checkStuck(job, now);
      return;
    }

    logger.info(
      {
        jobId: job.id,
        exchange: job.exchange,
        oldStatus: job.status,
        newStatus,
        txid: exchangeStatus.txid,
      },
      'Job status updated'
    );

    // Update job in database
    updateWithdrawalJob(job.id, {
      status: newStatus,
      txid: exchangeStatus.txid,
    });

    // Emit events based on new status
    switch (newStatus) {
      case 'complete':
        this.emit('jobComplete', { ...job, status: newStatus }, exchangeStatus.txid);
        break;

      case 'failed':
        this.handleJobFailure(job, exchangeStatus.error || 'Unknown failure');
        break;

      case 'held':
        this.emit('jobHeld', { ...job, status: newStatus });
        break;

      case 'cancelled':
        // Return amount to pending
        addPendingAmount(job.exchange, job.asset, job.amount);
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
          exchange: job.exchange,
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
