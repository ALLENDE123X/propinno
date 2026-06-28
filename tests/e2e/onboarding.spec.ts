import { test, expect } from '@playwright/test';

test('onboarding flow with mocked OTP', async ({ page }) => {
  // Mock the send-otp API
  await page.route('/api/auth/send-otp', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, devMode: true }),
    });
  });

  // Mock the verify-otp API
  await page.route('/api/auth/verify-otp', async (route) => {
    const postData = JSON.parse(route.request().postData() || '{}');
    if (postData.code === '000000') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, userId: 'test-user-id' }),
      });
    } else {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid OTP code' }),
      });
    }
  });

  await page.goto('/');

  // Step 1: Form submission
  await expect(page.locator('text=Start matching')).toBeVisible();

  await page.fill('input[type="tel"]', '4155550123');
  await page.fill('input[placeholder="$2,000"]', '2000');
  await page.fill('input[placeholder="$4,000"]', '4000');
  await page.fill('input[placeholder="1"]', '1');
  await page.fill('input[placeholder="2"]', '2');
  await page.fill('input[placeholder="Marina, 94123, Mission"]', '94123, Mission');

  await page.click('button[type="submit"]');

  // Step 2: OTP verification
  await expect(page.locator('label', { hasText: 'Verification Code' })).toBeVisible();

  // Try invalid code
  await page.fill('input[placeholder="123456"]', '123456');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Invalid OTP code')).toBeVisible();

  // Try valid code
  await page.fill('input[placeholder="123456"]', '000000');
  await page.click('button[type="submit"]');

  // Should redirect to checkout (though checkout page might not exist, it will just change URL)
  await page.waitForURL('**/checkout');
  expect(page.url()).toContain('/checkout');
});
