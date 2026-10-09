import { MongoClient, type Db } from 'mongodb';
import { env } from './env.js';

let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

function connect(): Promise<MongoClient> {
  if (!env.MONGODB_URI) {
    return Promise.reject(new Error('MongoDB is not configured. Set MONGODB_URI in .env'));
  }
  if (!connecting) {
    const pending = new MongoClient(env.MONGODB_URI);
    connecting = pending
      .connect()
      .then((connected) => {
        client = connected;
        return connected;
      })
      .catch((error) => {
        // Let the next caller retry instead of caching a failed connection forever.
        connecting = null;
        throw error;
      });
  }
  return connecting;
}

/** The shared database handle; connects on first use. */
export async function getDb(): Promise<Db> {
  return (await connect()).db();
}

export async function closeDatabase(): Promise<void> {
  if (client) await client.close();
  client = null;
  connecting = null;
}
