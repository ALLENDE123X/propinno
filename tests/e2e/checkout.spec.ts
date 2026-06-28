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
    } catch {
      console.warn("DB not accessible, skipping insert");
    }
  });

  test.afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  // Helper to set cookie for authentication
  async function authPage(context: import('@playwright/test').BrowserContext, userId: string) {
    await context.addCookies([
      {
        name: 'session',
        value: userId,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      }
    ]);
  }

  test('without session cookie shows missing ID', async ({ page }) => {
    await page.goto('/checkout');
    await expect(page.locator('text=User not found or Session expired')).toBeVisible();
  });

  test('with invalid session cookie shows user not found', async ({ page, context }) => {
    await authPage(context, '123e4567-e89b-12d3-a456-426614174000');
    await page.goto('/checkout');
    await expect(page.locator('text=User not found or Session expired')).toBeVisible();
  });

  test('with valid pending_payment user shows checkout options and can checkout', async ({ page, context }) => {
    if (!testUserId) test.skip();
    await authPage(context, testUserId);
    await page.goto('/checkout');
    await expect(page.locator('text=Choose your access pass')).toBeVisible();
    await expect(page.getByRole('heading', { name: '30-Day Pass' })).toBeVisible();
    
    // Simulate clicking checkout (it redirects to Stripe, so we just expect the URL to change or fail gracefully in tests)
    const checkoutBtn = page.getByRole('button', { name: 'Get 30-Day Pass' });
    await expect(checkoutBtn).toBeVisible();
    // In E2E we might not want to actually navigate to Stripe, but we can verify the button is clickable
    await checkoutBtn.click();
    // Usually Stripe redirect happens, so we just let it happen or verify loading state
    await expect(checkoutBtn).toBeDisabled();
  });

  test('with valid active user shows active pass state and can mark found place', async ({ page, context }) => {
    if (!testUserId) test.skip();
    await db.update(users).set({ status: 'active' }).where(eq(users.id, testUserId));
    await authPage(context, testUserId);
    await page.goto('/checkout');
    await expect(page.locator('text=Your pass is active')).toBeVisible();
    
    const foundPlaceBtn = page.locator('text=I found a place');
    await expect(foundPlaceBtn).toBeVisible();
    
    // Interact
    await foundPlaceBtn.click();
    
    // Should transition to 'done' state UI
    await expect(page.locator('text=Congratulations! 🎉')).toBeVisible();
    await expect(page.locator('text=I need to hunt again')).toBeVisible();
  });

  test('with done user can go back to expired state', async ({ page, context }) => {
    if (!testUserId) test.skip();
    await db.update(users).set({ status: 'done' }).where(eq(users.id, testUserId));
    await authPage(context, testUserId);
    await page.goto('/checkout');
    
    await expect(page.locator('text=Congratulations! 🎉')).toBeVisible();
    
    // Interact
    await page.locator('text=I need to hunt again').click();
    
    // Should transition to checkout passes again but with "Extend your access"
    await expect(page.locator('text=Extend your access')).toBeVisible();
  });
});
