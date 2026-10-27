// Shared read-only browser actions, used by production and the synthetic controls.
import { expect } from "@playwright/test";
async function textInConversationViewport(pane, text) {
  const expected = text.trim();
  if (!expected) return false;
  return pane.getByText(expected, { exact: true }).evaluateAll((elements, expected) => elements.some((element) => {
    // Playwright locators also collapse internal whitespace. The source proof
    // only permits trimming the paragraph's outer whitespace.
    if (element.textContent?.trim() !== expected) return false;
    const port = element.closest("[data-conversation-scroll]");
    if (!port || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = port.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, box.top) && rect.top < Math.min(innerHeight, box.bottom) && rect.right > Math.max(0, box.left) && rect.left < Math.min(innerWidth, box.right));
  }), expected);
}
async function findTurnRail(pane) {
  const named = pane.locator('nav[aria-label="Turn navigation"], nav[aria-label="\u8F6E\u6B21\u5BFC\u822A"]').first();
  if (await named.count() && await named.isVisible()) return named;
  const navs = pane.locator("nav[aria-label]");
  const count = await navs.count();
  for (let index = 0; index < count; index++) {
    if (!await navs.nth(index).isVisible()) continue;
    const labels = await navs.nth(index).locator("button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
    if (labels.some((label) => /jump to turn|load and jump|跳转到第|加载并跳转/i.test(label))) return navs.nth(index);
  }
  return void 0;
}
async function exerciseOpeningUnvisitedTarget(page, pane, expectedText, targetTurn) {
  const rail = await findTurnRail(pane);
  if (!rail || !await rail.count() || !await rail.isVisible())
    return { attempted: false, kind: null, committed: false, targetVisible: null, failure: "No visible official TurnNavigator rail" };
  const buttons = rail.locator("button");
  const scrollHandle = await rail.evaluateHandle((node) => [node, ...node.querySelectorAll("*")].find((element) => element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY)) ?? node);
  const scroller = scrollHandle.asElement();
  const readLabels = () => buttons.evaluateAll((nodes) => nodes.map((node, index) => {
    const box = node.getBoundingClientRect();
    const rail2 = node.closest("nav");
    let parent = node.parentElement, clipped = false;
    while (parent && rail2.contains(parent)) {
      if (/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) {
        const bounds = parent.getBoundingClientRect();
        if (box.bottom <= bounds.top || box.top >= bounds.bottom) clipped = true;
      }
      parent = parent.parentElement;
    }
    return {
      index,
      label: node.getAttribute("aria-label") ?? "",
      current: node.getAttribute("aria-current") === "true",
      disabled: node.disabled,
      visible: !clipped && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight,
      turn: Number(/(?:turn|第)\s*(\d+)/i.exec(node.getAttribute("aria-label") ?? "")?.[1] ?? Number.NaN)
    };
  }));
  let selected;
  for (let step = 0; step < 80; step++) {
    const labels = await readLabels();
    const eligible = labels.filter((row) => row.turn === targetTurn && row.visible);
    selected = eligible.find((row) => !row.disabled && /load and jump|加载并跳转/i.test(row.label)) ?? eligible.find((row) => !row.disabled && !row.current && /jump to turn|跳转到第/i.test(row.label));
    if (selected) break;
    const visibleTurns = labels.filter((row) => row.visible && Number.isFinite(row.turn)).map((row) => row.turn);
    if (!visibleTurns.length) break;
    const direction = targetTurn < Math.min(...visibleTurns) ? -1 : targetTurn > Math.max(...visibleTurns) ? 1 : 0;
    if (!direction) break;
    const geometry = await scroller.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      max: element.scrollHeight - element.clientHeight
    }));
    if (direction < 0 ? geometry.top <= 1 : geometry.top >= geometry.max - 1) break;
    const box = await scroller.boundingBox();
    if (!box) break;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, direction * Math.max(40, geometry.height * 0.75));
    try {
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop), { timeout: 1e3 }).not.toBe(geometry.top);
    } catch {
      break;
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  await scrollHandle.dispose();
  if (!selected)
    return { attempted: false, kind: null, committed: false, targetVisible: null, failure: `Expected navigation turn ${targetTurn} was not present in the official rail` };
  if (await textInConversationViewport(pane, expectedText))
    return {
      attempted: false,
      kind: "target",
      committed: false,
      targetVisible: true,
      failure: "The navigation target was already visible; the action did not exercise navigation"
    };
  const baseline = await page.evaluate(() => window.__hapiColdOpening.navigation?.commitRevision ?? 0);
  const kind = /load and jump|加载并跳转/i.test(selected.label) ? "load-jump" : "jump";
  await rail.getByRole("button", { name: selected.label, exact: true }).click();
  let failure = null;
  try {
    await expect.poll(() => textInConversationViewport(pane, expectedText), { timeout: 12e3 }).toBe(true);
    await page.waitForFunction((base) => (window.__hapiColdOpening.navigation?.commitRevision ?? 0) > base, baseline, { timeout: 12e3 });
  } catch {
    failure = "Unvisited navigation target did not commit the exact text";
  }
  const committed = await page.evaluate((base) => (window.__hapiColdOpening.navigation?.commitRevision ?? 0) > base, baseline);
  const targetVisible = await textInConversationViewport(pane, expectedText);
  return { attempted: true, kind, committed, targetVisible, failure };
}
export {
  exerciseOpeningUnvisitedTarget,
  textInConversationViewport
};
