import { expect, test } from '@playwright/test'

test.describe('Effect RPC + TanStack Start', () => {
  test('loads initial users from server', async ({ page }) => {
    await page.goto('/')

    // Wait for the user list to load
    const userList = page.getByTestId('user-list')
    await expect(userList).toBeVisible()

    // Check that initial users are displayed
    await expect(page.getByTestId('user-1')).toContainText('Alice')
    await expect(page.getByTestId('user-2')).toContainText('Bob')
  })

  test('creates a new user via RPC', async ({ page }) => {
    await page.goto('/')

    // Fill in the form
    await page.getByTestId('name-input').fill('Charlie')
    await page.getByTestId('email-input').fill('charlie@example.com')

    // Submit the form
    await page.getByTestId('submit-button').click()

    // Wait for the new user to appear in the list
    await expect(page.getByTestId('user-3')).toContainText('Charlie')
    await expect(page.getByTestId('user-3')).toContainText('charlie@example.com')
  })

  test('navigates to user detail page', async ({ page }) => {
    await page.goto('/users/1')

    // Check user details are displayed
    await expect(page.getByTestId('user-id')).toHaveText('1')
    await expect(page.getByTestId('user-name')).toHaveText('Alice')
    await expect(page.getByTestId('user-email')).toHaveText('alice@example.com')
  })

  test('handles user not found error', async ({ page }) => {
    await page.goto('/users/999')

    // Check error message is displayed
    await expect(page.getByText('User not found: 999')).toBeVisible()
  })
})
