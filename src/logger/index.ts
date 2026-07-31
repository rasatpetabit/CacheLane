import * as fs from 'fs';
import * as path from 'path';
import { cachelaneHome } from '../cli/paths.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  logDir?: string;
  maxFileSize?: number;
  maxFiles?: number;
  sessionId?: string;
  minLevel?: LogLevel;
}

export class Logger {
  private logDir: string;
  private logFile: string;
  private maxFileSize: number;
  private maxFiles: number;
  private currentFileSize = 0;
  private sessionId: string;
  private minLevel: number;
  private initializationFailed = false;
  private muteReported = false;
  private logDirIsExplicit: boolean;

  constructor(options: LoggerOptions = {}) {
    // Must honour CACHELANE_HOME. This previously hardcoded ~/.cachelane, which
    // silently broke dual-home deploys: the LiteLLM unit runs with
    // CACHELANE_HOME=~/.cachelane-litellm under ProtectHome=read-only, and
    // ~/.cachelane is not in its ReadWritePaths — so every write failed EROFS
    // into the bare catch below and that lane never produced a single log line.
    // Months of "the LiteLLM lane logged nothing" was an artifact of this bug,
    // not a finding.
    this.logDirIsExplicit = Boolean(options.logDir);
    this.logDir = options.logDir || cachelaneHome();
    this.logFile = path.join(this.logDir, 'cachelane.log');
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.maxFiles = options.maxFiles || 5;
    this.sessionId = options.sessionId || 'unknown';
    
    const envLevel = process.env.CACHELANE_DEBUG === '1' ? 'debug' : 'info';
    this.minLevel = LEVELS[options.minLevel || envLevel as LogLevel];

    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      
      if (fs.existsSync(this.logFile)) {
        const stats = fs.statSync(this.logFile);
        this.currentFileSize = stats.size;
        if (this.currentFileSize >= this.maxFileSize) {
          this.rotateSync();
        }
      }
    } catch (err) {
      // Fail-open: if we can't create dir or stat file, we just disable logging
      this.initializationFailed = true;
      this.reportMute(err);
    }
  }

  /**
   * Announce, once per logger, that it cannot write its log.
   *
   * Failing open is right — a log write must never break a proxied request —
   * but failing open *silently* is what let one lane run mute indefinitely
   * while its silence was repeatedly read as evidence of health. stderr reaches
   * journald even when the log file does not, so the operator gets one line
   * naming the unwritable path instead of nothing at all.
   *
   * Deliberately per-instance rather than module-scope: production has exactly
   * one Logger (the singleton below), so the two are equivalent there, and
   * instance state keeps this free of global mutable state that would make test
   * outcomes depend on file ordering.
   *
   * The diagnostic is itself wrapped, because this runs inside the fail-open
   * catch. A console that throws — a closed or redirected stderr, an overridden
   * global — must not turn a swallowed log write into an exception on the
   * request path. Nothing is left to do if even stderr is gone.
   */
  private reportMute(err: unknown) {
    if (this.muteReported) return;
    this.muteReported = true;
    try {
      const reason = err instanceof Error ? err.message : String(err);
      // An explicit logDir wins over the environment, so telling that caller to
      // set CACHELANE_HOME would be advice that cannot work.
      const remedy = this.logDirIsExplicit
        ? `Pass a writable logDir, or add this path to the unit's ReadWritePaths.`
        : `Set CACHELANE_HOME to a writable directory, or add this path to the ` +
          `unit's ReadWritePaths.`;
      console.error(
        `[cachelane] logging disabled: cannot write ${this.logFile} (${reason}). ${remedy}`,
      );
    } catch {
      // Fail-open all the way down.
    }
  }

  public setSessionId(id: string) {
    this.sessionId = id;
  }

  private rotateSync() {
    try {
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const oldFile = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
        const newFile = `${this.logFile}.${i}`;
        if (fs.existsSync(oldFile)) {
          if (i === this.maxFiles) {
            fs.unlinkSync(oldFile);
          } else {
            fs.renameSync(oldFile, newFile);
          }
        }
      }
      this.currentFileSize = 0;
    } catch {
      // Fail-open: if rotation fails, we might just keep writing to the same file or stop logging.
      this.currentFileSize = 0;
    }
  }

  public log(level: LogLevel, event: string, message: string, error?: unknown) {
    if (this.initializationFailed || LEVELS[level] < this.minLevel) {
      return;
    }

    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      pid: process.pid,
      session_id: this.sessionId,
      event,
      message,
    };

    if (level === 'error' && error instanceof Error) {
      payload.err = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else if (level === 'error' && error !== undefined) {
      payload.err = {
        message: String(error),
      };
    }

    const line = JSON.stringify(payload) + '\n';
    const lineSize = Buffer.byteLength(line);

    try {
      if (this.currentFileSize + lineSize > this.maxFileSize) {
        this.rotateSync();
      }

      fs.appendFileSync(this.logFile, line);
      this.currentFileSize += lineSize;
    } catch (err) {
      // Fail-open: a failed log write must never break a proxied request. But
      // say so once (see reportMute) rather than discarding every line in
      // silence.
      this.reportMute(err);
    }
  }

  public debug(event: string, message: string) {
    this.log('debug', event, message);
  }

  public info(event: string, message: string) {
    this.log('info', event, message);
  }

  public warn(event: string, message: string) {
    this.log('warn', event, message);
  }

  public error(event: string, message: string, error?: unknown) {
    this.log('error', event, message, error);
  }
}

// Export a singleton instance for default usage
export const logger = new Logger();
