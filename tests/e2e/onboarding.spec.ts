import { test, expect } from '@playwright/test';

test('onboarding flow with mocked OTP and preview step', async ({ page }) => {
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

  // Mock the listings preview API — return 2 matching listings
  await page.route('/api/listings/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        listings: [
          { id: 'l1', neighborhood: 'Mission, San Francisco, CA', price: 2800, beds: 1, baths: 1, source: 'rentcast', postedAt: null },
          { id: 'l2', neighborhood: 'SoMa, San Francisco, CA', price: 3200, beds: 2, baths: 1, source: 'craigslist', postedAt: null },
        ],
      }),
    });
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

  // Step 3: Preview step should be shown (not redirect to checkout directly)
  await expect(page.locator('text=already match your criteria').or(page.locator('text=scanning for your perfect match'))).toBeVisible({ timeout: 5000 });

  // Preview cards should show matching listing teasers
  await expect(page.locator('text=Mission, San Francisco, CA')).toBeVisible();
  await expect(page.locator('text=$2,800/mo')).toBeVisible();

  // Link should be locked (gated)
  await expect(page.locator('text=Link')).toBeVisible();

  // CTA leads to checkout
  await page.click('#preview-cta-90day');
  await page.waitForURL('**/checkout');
  expect(page.url()).toContain('/checkout');
});

test('onboarding preview shows empty state when no listings', async ({ page }) => {
  await page.route('/api/auth/send-otp', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('/api/auth/verify-otp', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, userId: 'test-user-id' }) });
  });
  await page.route('/api/listings/preview', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ listings: [] }) });
  });

  await page.goto('/');
  await page.fill('input[type="tel"]', '4155550123');
  await page.click('button[type="submit"]');
  await expect(page.locator('label', { hasText: 'Verification Code' })).toBeVisible();
  await page.fill('input[placeholder="123456"]', '000000');
  await page.click('button[type="submit"]');

  // Empty state should show
  await expect(page.locator('text=scanning for your perfect match').or(page.locator('text=No listings indexed yet'))).toBeVisible({ timeout: 5000 });

  // CTA still present
  await expect(page.locator('#preview-cta-90day')).toBeVisible();
});
