import { expect, type Locator, type Page } from '@playwright/test'

async function focusVisiblePane(pane: Locator): Promise<void> {
    const header = pane.locator('.hapi-pane-header')
    const mobile = await pane.evaluate(element => element.closest('.hapi-workspace-mobile') !== null)
    if (mobile) await expect(header).toBeHidden()
    else await header.click({ position: { x: 4, y: 4 } })
    // Mobile renders only the focused pane and keeps its header hidden.
    // Assert the public focus state instead of clicking invisible chrome.
    await expect(pane).toHaveClass(/\bhapi-pane-focused\b/)
}

/** Follow the current composer menu, including the official pane transition. */
export async function openConversationTool(page: Page, sessionTitle: string, tool: string) {
    const pane = page.getByRole('region', { name: `Pane: ${tool}`, exact: true })
    if (await pane.isVisible()) {
        await focusVisiblePane(pane)
        return pane
    }
    const existingChat = page.getByRole('region', { name: `Pane: ${sessionTitle}`, exact: true })
    if (await existingChat.isVisible()) await focusVisiblePane(existingChat)
    else {
        const row = page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: sessionTitle })
        const back = page.locator('.hapi-mobile-back')
        if (!await row.isVisible() && await back.isVisible()) await back.click()
        await row.click()
    }
    const chat = page.getByRole('region', { name: `Pane: ${sessionTitle}`, exact: true }).and(page.locator('.hapi-pane-focused'))
    await chat.getByRole('button', { name: 'More input controls', exact: true }).click()
    await page.getByRole('dialog', { name: 'More input controls', exact: true }).getByRole('button', { name: tool, exact: true }).click()
    await expect(pane).toBeVisible()
    return pane
}
