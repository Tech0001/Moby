/**
 * In-memory ring buffer for log entries.
 * Stores recent logs for display in the UI.
 */

export interface LogEntry {
  id: number;
  timestamp: number;
  level: number;
  levelLabel: string;
  module?: string;
  msg: string;
  data?: Record<string, unknown>;
}

const LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

class LogBuffer {
  private buffer: LogEntry[] = [];
  private maxSize: number;
  private idCounter = 0;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Add a log entry to the buffer
   */
  push(entry: Omit<LogEntry, 'id' | 'levelLabel'>): void {
    const logEntry: LogEntry = {
      ...entry,
      id: ++this.idCounter,
      levelLabel: LEVEL_LABELS[entry.level] || 'unknown',
    };

    this.buffer.push(logEntry);

    // Remove oldest entries if buffer is full
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /**
   * Get all logs, optionally filtered by level and/or since a specific ID
   */
  getLogs(options?: {
    minLevel?: number;
    sinceId?: number;
    limit?: number;
    module?: string;
  }): LogEntry[] {
    let logs = this.buffer;

    const sinceId = options?.sinceId;
    const minLevel = options?.minLevel;
    const module = options?.module;
    const limit = options?.limit;

    if (sinceId !== undefined) {
      logs = logs.filter(l => l.id > sinceId);
    }

    if (minLevel !== undefined) {
      logs = logs.filter(l => l.level >= minLevel);
    }

    if (module !== undefined) {
      logs = logs.filter(l => l.module === module);
    }

    if (limit !== undefined) {
      logs = logs.slice(-limit);
    }

    return logs;
  }

  /**
   * Get the latest log ID (for polling)
   */
  getLatestId(): number {
    return this.idCounter;
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get buffer stats
   */
  getStats(): { count: number; maxSize: number; latestId: number } {
    return {
      count: this.buffer.length,
      maxSize: this.maxSize,
      latestId: this.idCounter,
    };
  }
}

// Singleton instance
export const logBuffer = new LogBuffer(500);

/**
 * Pino destination that writes to the log buffer
 */
export function createLogBufferDestination() {
  return {
    write(chunk: string) {
      try {
        const parsed = JSON.parse(chunk);
        const { time, level, module, msg, ...rest } = parsed;

        // Remove pino internal fields from data
        const data = { ...rest };
        delete data.pid;
        delete data.hostname;

        logBuffer.push({
          timestamp: time || Date.now(),
          level: level || 30,
          module,
          msg: msg || '',
          data: Object.keys(data).length > 0 ? data : undefined,
        });
      } catch {
        // If we can't parse JSON, store as raw message
        logBuffer.push({
          timestamp: Date.now(),
          level: 30,
          msg: chunk.trim(),
        });
      }
    },
  };
}
