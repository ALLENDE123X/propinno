import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

let db: PostgresJsDatabase<typeof schema>

if (process.env.DATABASE_URL) {
  const client = postgres(process.env.DATABASE_URL, { prepare: false })
  db = drizzle(client, { schema })
} else {
  // Create a dummy client and database instance to act as the Proxy target.
  // This ensures prototype checks (like Drizzle's `is(db, PgDatabase)`) succeed during static compilation
  // and do not throw "Unsupported database type" errors in adapter initializations like NextAuth.
  const dummyClient = postgres('postgresql://localhost:5432/postgres', { prepare: false })
  const dummyDb = drizzle(dummyClient, { schema })

  // Use Proxy to handle database operations lazily when DATABASE_URL is available
  db = new Proxy(dummyDb, {
    get(target, prop) {
      // Delegate symbols, constructor, and then-able checks to the dummy database to avoid crashing
      // during library initialization and static analysis when DATABASE_URL is absent.
      if (
        !process.env.DATABASE_URL &&
        (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then')
      ) {
        return Reflect.get(target, prop)
      }

      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is missing from environment variables. Cannot execute database operations.')
      }
      const client = postgres(process.env.DATABASE_URL, { prepare: false })
      const actualDb = drizzle(client, { schema })
      return Reflect.get(actualDb, prop)
    }
  }) as PostgresJsDatabase<typeof schema>
}

export { db }
export type DbType = typeof db

