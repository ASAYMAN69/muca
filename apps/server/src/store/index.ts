import type { DatabaseSync } from 'node:sqlite';

import { Database, defaultDatabasePath } from './db.js';
import { SessionStore, MessageStore } from './sessions.js';
import { EventStore } from './events.js';
import { RunStore } from './runs.js';
import { ApprovalStore } from './approvals.js';
import { RequestStore } from './requests.js';
import { PolicyStore } from './policies.js';

/**
 * The database, with one store per concern.
 *
 * The stores are thin, typed wrappers over SQL statements. There is no
 * ORM and no migration framework: the schema is created when the database
 * is opened.
 */
export class MucaStore {
  readonly database: Database;
  readonly sessions: SessionStore;
  readonly messages: MessageStore;
  readonly events: EventStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalStore;
  readonly requests: RequestStore;
  readonly policies: PolicyStore;

  constructor(path: string = defaultDatabasePath()) {
    this.database = new Database(path);
    const db: DatabaseSync = this.database.handle;
    this.sessions = new SessionStore(db);
    this.messages = new MessageStore(db);
    this.events = new EventStore(db);
    this.runs = new RunStore(db);
    this.approvals = new ApprovalStore(db);
    this.requests = new RequestStore(db);
    this.policies = new PolicyStore(db);
  }

  /** The path of the database file. */
  get path(): string {
    return this.database.path;
  }

  /** Closes the database. */
  close(): void {
    this.database.close();
  }
}

export * from './db.js';
export * from './sessions.js';
export * from './events.js';
export * from './runs.js';
export * from './approvals.js';
export * from './requests.js';
export * from './policies.js';
