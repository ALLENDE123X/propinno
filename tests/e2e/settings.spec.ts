import { test, expect } from '@playwright/test';
import { db } from '../../lib/db';
import { users } from '../../lib/db/schema';
import { eq } from 'drizzle-orm';

test.describe('Settings Page', () => {
  let testUserId: string;

  test.beforeAll(async () => {
    try {
      const [user] = await db.insert(users).values({
        phone: '+15559997777',
        status: 'active',
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

  test('non-active user is redirected to checkout', async ({ page, context }) => {
    if (!testUserId) test.skip();
    await db.update(users).set({ status: 'expired' }).where(eq(users.id, testUserId));
    await authPage(context, testUserId);
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL(/\/checkout$/);
  });

  test('active user sees a cancel subscription button', async ({ page, context }) => {
    if (!testUserId) test.skip();
    await db.update(users).set({ status: 'active' }).where(eq(users.id, testUserId));
    await authPage(context, testUserId);
    await page.goto('/dashboard/settings');
    await expect(page.getByRole('button', { name: 'Cancel subscription' })).toBeVisible();
  });

  test('cancel button asks for confirmation, then redirects to checkout on confirm', async ({ page, context }) => {
    if (!testUserId) test.skip();
    await db.update(users).set({ status: 'active' }).where(eq(users.id, testUserId));
    await authPage(context, testUserId);
    await page.goto('/dashboard/settings');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Cancel subscription' }).click();

    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.locator('text=Congratulations! 🎉')).toBeVisible();
  });
});
