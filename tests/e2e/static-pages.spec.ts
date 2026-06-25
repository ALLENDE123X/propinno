import { test, expect } from '@playwright/test'

test.describe('Static Pages E2E', () => {
  test('should navigate to privacy policy page and render successfully', async ({ page }) => {
    await page.goto('/privacy')
    const heading = page.getByRole('heading', { level: 1, name: 'Privacy Policy' })
    await expect(heading).toBeVisible()
  })

  test('should navigate to terms of service page and render successfully', async ({ page }) => {
    await page.goto('/terms')
    const heading = page.getByRole('heading', { level: 1, name: 'Terms of Service' })
    await expect(heading).toBeVisible()
  })
})
