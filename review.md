## PR Review: feat: AH-008 Implement Matching Engine

**Vercel: ✅ Ready**
**CI: ✅ Passing**
**Overall: ❌ REQUEST CHANGES**

### Spec Compliance
- **Line 28:** Queries table `user_preferences`, but the PRD schema (Section 3) explicitly defines the table as `criteria`.
- **Line 30:** Uses column `max_price`, but the PRD schema defines it as `price_max`.
- **Line 31:** Uses column `min_beds`, but the PRD schema defines it as `beds_min`.
- **Line 32:** Uses column `min_baths`, which is not defined in the `criteria` schema.
- **Lines 34-37:** Implements distance-based geo-matching using `lng`, `lat`, and `search_radius_meters`. The PRD location criteria are strictly based on arrays: `zips[]` and `neighborhoods[]`.
- **Lines 26-40 (Missing Logic):** Does not check if the user is active. The PRD (Section 4, Step 3) requires matching against "active users whose criteria fit".
- **Lines 26-40 (Missing Logic):** Does not exclude already-sent listings. The PRD (Section 4, Step 3) dictates "minus already-`sent`".

### Security
PASS

### Code Quality
- `inngest/functions/matchingEngine.ts:59`: `logger.error({ err: error }, 'Matching engine failed')` is too vague. It should include context like `event.data.listingIds` to clarify which payload caused the failure.
- `inngest/functions/matchingEngine.ts:10-62`: The main function callback is 53 lines long. The user matching logic and SQL query execution should be decomposed into a separate helper function to bring the main handler under the 50-line limit.

### Test Coverage
- **Weak Test: `matchingEngine.test.ts` bypasses core logic.** The test completely mocks `db.execute` to return a predefined response. Replace the mock with an integration-style test against a test database to actually verify the `IS NULL` edge cases, bound checks, and duplication checks. Alternatively, extract the SQL string generation into a unit-testable helper function.
- **Missing Edge Cases:** Error Handling (catch block/Sentry), No Matches Found (empty array from db.execute), Missing Listings in DB (empty array from findMany).

### Must fix before merge
- Fix the SQL query to use the correct `criteria` table and column names (`price_max`, `beds_min`, `zips`, `neighborhoods`).
- Implement user status check (`active`) and exclude already-sent notifications.
- Decompose the SQL query logic into a helper function and add comprehensive tests for it (including edge cases).
- Add `listingIds` context to the error log.
