import { expect, type Page } from '@playwright/test'

/** Follow the current composer menu, including the official pane transition. */
export async function openConversationTool(page: Page, sessionTitle: string, tool: string) {
    const pane = page.getByRole('region', { name: `Pane: ${tool}`, exact: true })
    if (await pane.isVisible()) {
        await pane.locator('.hapi-pane-header').click({ position: { x: 4, y: 4 } })
        return pane
    }
    const existingChat = page.getByRole('region', { name: `Pane: ${sessionTitle}`, exact: true })
    if (await existingChat.isVisible()) await existingChat.locator('.hapi-pane-header').click({ position: { x: 4, y: 4 } })
    else await page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: sessionTitle }).click()
    const chat = page.getByRole('region', { name: `Pane: ${sessionTitle}`, exact: true }).and(page.locator('.hapi-pane-focused'))
    await chat.getByRole('button', { name: 'More input controls', exact: true }).click()
    await page.getByRole('dialog', { name: 'More input controls', exact: true }).getByRole('button', { name: tool, exact: true }).click()
    await expect(pane).toBeVisible()
    return pane
}
