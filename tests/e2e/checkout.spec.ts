import { test, expect } from '@playwright/test';

test('Checkout page without userId shows missing ID', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.locator('text=Missing User ID')).toBeVisible();
});

test('Checkout page with invalid userId shows user not found', async ({ page }) => {
  // Pass an invalid UUID so it fails to find the user
  await page.goto('/checkout?userId=123e4567-e89b-12d3-a456-426614174000');
  
  // Should show User not found after loading
  await expect(page.locator('text=User not found')).toBeVisible();
});
