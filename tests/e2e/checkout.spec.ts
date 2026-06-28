import { test, expect } from '@playwright/test';
import { db } from '../../lib/db';
import { users } from '../../lib/db/schema';
import { eq } from 'drizzle-orm';

test.describe('Checkout Page', () => {
  let testUserId: string;

  test.beforeAll(async () => {
    // Only insert if DB is accessible to avoid local ENOTFOUND issues crashing tests
    try {
      const [user] = await db.insert(users).values({
        phone: '+15559998888',
        status: 'pending_payment',
      }).returning();
      testUserId = user.id;
    } catch (e) {
      console.warn("DB not accessible, skipping insert");
    }
  });

  test.afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  test('without userId shows missing ID', async ({ page }) => {
    await page.goto('/checkout');
    await expect(page.locator('text=Missing User ID')).toBeVisible();
  });

  test('with invalid userId shows user not found', async ({ page }) => {
    await page.goto('/checkout?userId=123e4567-e89b-12d3-a456-426614174000');
    await expect(page.locator('text=User not found')).toBeVisible();
  });

  test('with valid pending_payment user shows checkout options', async ({ page }) => {
    if (!testUserId) test.skip();
    await page.goto(`/checkout?userId=${testUserId}`);
    await expect(page.locator('text=Choose your access pass')).toBeVisible();
    await expect(page.locator('text=30-Day Pass')).toBeVisible();
    await expect(page.locator('text=90-Day Pass')).toBeVisible();
  });

  test('with valid active user shows active pass state', async ({ page }) => {
    if (!testUserId) test.skip();
    await db.update(users).set({ status: 'active' }).where(eq(users.id, testUserId));
    await page.goto(`/checkout?userId=${testUserId}`);
    await expect(page.locator('text=Your pass is active')).toBeVisible();
    await expect(page.locator('text=I found a place')).toBeVisible();
  });
});
