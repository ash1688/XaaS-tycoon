// Creates, migrates and empties the e2e database before the server starts.
import { setupTestDb } from "../server/test/testDb.ts";

const { reset, close } = await setupTestDb(process.env.DATABASE_URL);
await reset();
await close();
