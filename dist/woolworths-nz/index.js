#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import puppeteer from "puppeteer";
import * as dotenv from "dotenv";
dotenv.config();
const BASE_URL = "https://www.woolworths.co.nz";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS = process.env.WOOLWORTHS_HEADLESS !== "false";
// Browser session — kept alive across tool calls
let _browser = null;
let _page = null;
async function getBrowser() {
    if (!_browser || !_browser.connected) {
        _browser = await puppeteer.launch({
            headless: HEADLESS,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });
    }
    return _browser;
}
async function getPage() {
    const b = await getBrowser();
    if (!_page || _page.isClosed()) {
        _page = await b.newPage();
        await _page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await _page.setViewport({ width: 1280, height: 900 });
    }
    return _page;
}
// Dismiss cookie/overlay banners that block interaction
async function dismissOverlays(p) {
    const candidates = [
        "#onetrust-accept-btn-handler",
        '[data-testid="accept-cookies"]',
        'button[aria-label*="Accept" i]',
        'button[class*="cookie"][class*="accept" i]',
    ];
    for (const sel of candidates) {
        try {
            const el = await p.$(sel);
            if (el) {
                await el.click();
                await sleep(400);
                break;
            }
        }
        catch {
            // selector not present — continue
        }
    }
}
// Try multiple selectors in order, return first match
async function findElement(p, selectors) {
    for (const sel of selectors) {
        const el = await p.$(sel);
        if (el)
            return { el, sel };
    }
    return null;
}
// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server({ name: "woolworths-nz", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "woolworths_login",
            description: "Log in to your Woolworths NZ account. Call this first each session. Credentials can also be pre-set via WOOLWORTHS_EMAIL / WOOLWORTHS_PASSWORD environment variables.",
            inputSchema: {
                type: "object",
                properties: {
                    email: { type: "string", description: "Woolworths account email (overrides env var)" },
                    password: { type: "string", description: "Woolworths account password (overrides env var)" },
                },
                required: [],
            },
        },
        {
            name: "woolworths_search",
            description: "Search for products on Woolworths NZ. Returns product names, prices, IDs, and whether they're on special. Use the returned IDs with woolworths_add_to_cart.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Product to search for, e.g. 'chicken breast', 'whole milk 2L'" },
                    limit: { type: "number", description: "Max results to return (default 8, max 20)", default: 8 },
                    onSpecialOnly: { type: "boolean", description: "Return only products currently on special", default: false },
                },
                required: ["query"],
            },
        },
        {
            name: "woolworths_add_to_cart",
            description: "Add a product to the cart by its ID (from woolworths_search results).",
            inputSchema: {
                type: "object",
                properties: {
                    productId: { type: "string", description: "Product ID from woolworths_search" },
                    quantity: { type: "number", description: "Quantity to add (default 1)", default: 1 },
                },
                required: ["productId"],
            },
        },
        {
            name: "woolworths_view_cart",
            description: "View all items currently in the Woolworths NZ cart, with quantities and total cost.",
            inputSchema: { type: "object", properties: {} },
        },
        {
            name: "woolworths_remove_from_cart",
            description: "Remove a specific product from the cart by its ID.",
            inputSchema: {
                type: "object",
                properties: {
                    productId: { type: "string", description: "Product ID to remove" },
                },
                required: ["productId"],
            },
        },
        {
            name: "woolworths_clear_cart",
            description: "Remove ALL items from the Woolworths NZ cart. Confirm with the user before calling this.",
            inputSchema: { type: "object", properties: {} },
        },
        {
            name: "woolworths_get_specials",
            description: "Browse current weekly specials on Woolworths NZ, optionally filtered by category. Useful for planning meals around deals.",
            inputSchema: {
                type: "object",
                properties: {
                    category: {
                        type: "string",
                        description: "Category to filter by, e.g. 'meat', 'fruit-vegetables', 'dairy'. Leave blank for all specials.",
                    },
                    limit: { type: "number", description: "Max results (default 20)", default: 20 },
                },
                required: [],
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            // ── LOGIN ──────────────────────────────────────────────────────────────
            case "woolworths_login": {
                const email = String(args?.email ?? process.env.WOOLWORTHS_EMAIL ?? "");
                const password = String(args?.password ?? process.env.WOOLWORTHS_PASSWORD ?? "");
                if (!email || !password) {
                    return {
                        content: [{
                                type: "text",
                                text: "No credentials provided. Pass email/password args or set WOOLWORTHS_EMAIL and WOOLWORTHS_PASSWORD in .env",
                            }],
                    };
                }
                const p = await getPage();
                await p.goto(`${BASE_URL}/account/login`, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                const emailField = await findElement(p, [
                    'input[name="email"]',
                    'input[type="email"]',
                    'input[placeholder*="email" i]',
                ]);
                if (!emailField) {
                    return {
                        content: [{ type: "text", text: "Could not find the login form. The page structure may have changed — try setting WOOLWORTHS_HEADLESS=false to debug visually." }],
                    };
                }
                await emailField.el.click({ clickCount: 3 });
                await emailField.el.type(email);
                const passwordField = await findElement(p, ['input[type="password"]', 'input[name="password"]']);
                if (!passwordField) {
                    return { content: [{ type: "text", text: "Could not find the password field." }] };
                }
                await passwordField.el.type(password);
                await Promise.all([
                    p.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
                    p.click('button[type="submit"]'),
                ]);
                const url = p.url();
                if (url.includes("/account/login")) {
                    return { content: [{ type: "text", text: "Login failed — incorrect email or password." }] };
                }
                return { content: [{ type: "text", text: `Logged in successfully. Current page: ${url}` }] };
            }
            // ── SEARCH ─────────────────────────────────────────────────────────────
            case "woolworths_search": {
                const query = String(args?.query ?? "");
                const limit = Math.min(Number(args?.limit ?? 8), 20);
                const onSpecialOnly = Boolean(args?.onSpecialOnly ?? false);
                if (!query)
                    return { content: [{ type: "text", text: "query is required" }] };
                const p = await getPage();
                const searchUrl = `${BASE_URL}/shop/search-products/search?q=${encodeURIComponent(query)}&inStoreOnly=false`;
                await p.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                // Wait for product tiles to appear
                const tileSelectors = [
                    '[class*="ProductTile"]',
                    '[class*="product-tile"]',
                    '[data-testid*="product-tile"]',
                    'section[class*="product"]',
                ];
                for (const sel of tileSelectors) {
                    try {
                        await p.waitForSelector(sel, { timeout: 5000 });
                        break;
                    }
                    catch {
                        // try next
                    }
                }
                const products = await p.evaluate((lim, specialOnly) => {
                    const selectors = [
                        '[class*="ProductTile"]',
                        '[class*="product-tile"]',
                        '[data-testid*="product-tile"]',
                        'section[class*="product"]',
                        'article[class*="product"]',
                    ];
                    let tiles = [];
                    for (const sel of selectors) {
                        tiles = Array.from(document.querySelectorAll(sel));
                        if (tiles.length > 0)
                            break;
                    }
                    return tiles
                        .map((tile) => {
                        const nameEl = tile.querySelector('[class*="ProductName"]') ??
                            tile.querySelector('[class*="product-name"]') ??
                            tile.querySelector('[data-testid*="product-title"]') ??
                            tile.querySelector("h3") ??
                            tile.querySelector("h4");
                        const priceEl = tile.querySelector('[class*="PriceValue"]') ??
                            tile.querySelector('[class*="price-value"]') ??
                            tile.querySelector('[data-testid*="price"]') ??
                            tile.querySelector('[class*="Price"]:not([class*="Was"])');
                        const wasEl = tile.querySelector('[class*="WasPrice"]') ??
                            tile.querySelector('[class*="was-price"]') ??
                            tile.querySelector('[class*="OriginalPrice"]');
                        const unitEl = tile.querySelector('[class*="CupPrice"]') ??
                            tile.querySelector('[class*="cup-price"]') ??
                            tile.querySelector('[class*="UnitPrice"]');
                        // Product ID — Woolworths NZ embeds it in data attributes or button attrs
                        const idSources = [
                            tile.getAttribute("data-product-id"),
                            tile.getAttribute("data-id"),
                            tile.querySelector("[data-product-id]")?.getAttribute("data-product-id"),
                            tile.querySelector("button[data-product-id]")?.getAttribute("data-product-id"),
                            // fallback: extract from any add-to-cart button href/data
                            tile.querySelector('button[class*="add" i]')?.dataset?.productId,
                            // last resort: grab from product page link
                            tile.querySelector("a[href*='/shop/productdetails']")?.getAttribute("href")?.match(/\/(\d+)\//)?.[1],
                        ];
                        const id = idSources.find(Boolean) ?? "";
                        const isOnSpecial = !!wasEl;
                        return {
                            id,
                            name: nameEl?.textContent?.trim() ?? "",
                            price: priceEl?.textContent?.trim() ?? "",
                            unit: unitEl?.textContent?.trim() ?? "",
                            isOnSpecial,
                        };
                    })
                        .filter((p) => p.name && (!specialOnly || p.isOnSpecial))
                        .slice(0, lim);
                }, limit, onSpecialOnly);
                if (!products.length) {
                    return {
                        content: [{
                                type: "text",
                                text: `No products found for "${query}". You may need to log in first, or the search returned no results.`,
                            }],
                    };
                }
                const lines = products.map((p, i) => {
                    const special = p.isOnSpecial ? " [ON SPECIAL]" : "";
                    const unit = p.unit ? ` (${p.unit})` : "";
                    const id = p.id ? ` — ID: ${p.id}` : " — ID: unknown";
                    return `${i + 1}. ${p.name}${special}\n   Price: ${p.price}${unit}${id}`;
                });
                return {
                    content: [{
                            type: "text",
                            text: `Search results for "${query}":\n\n${lines.join("\n\n")}`,
                        }],
                };
            }
            // ── ADD TO CART ────────────────────────────────────────────────────────
            case "woolworths_add_to_cart": {
                const productId = String(args?.productId ?? "");
                const quantity = Number(args?.quantity ?? 1);
                if (!productId)
                    return { content: [{ type: "text", text: "productId is required" }] };
                const p = await getPage();
                // Navigate to the product's detail page — this is the most reliable way to add
                // Woolworths NZ product detail URL pattern (verify/adjust if changed):
                const productUrl = `${BASE_URL}/shop/productdetails/${productId}`;
                await p.goto(productUrl, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                const addBtn = await findElement(p, [
                    'button[data-testid="add-to-cart"]',
                    'button[class*="AddToCart"]',
                    'button[class*="add-to-cart"]',
                    'button[aria-label*="Add to cart" i]',
                    'button[class*="AddButton"]',
                ]);
                if (!addBtn) {
                    return {
                        content: [{
                                type: "text",
                                text: `Could not find the Add to Cart button for product ${productId}. The product may be out of stock, unavailable, or the page structure may have changed.`,
                            }],
                    };
                }
                // If quantity > 1, we need to set it first
                if (quantity > 1) {
                    const qtyInput = await findElement(p, [
                        'input[data-testid="quantity-input"]',
                        'input[class*="quantity"]',
                        'input[type="number"]',
                    ]);
                    if (qtyInput) {
                        await qtyInput.el.click({ clickCount: 3 });
                        await qtyInput.el.type(String(quantity));
                    }
                }
                await addBtn.el.click();
                await sleep(1200);
                // Confirm by checking cart icon count increased
                const cartCount = await p.evaluate(() => {
                    const el = document.querySelector('[data-testid="cart-quantity"]') ??
                        document.querySelector('[class*="CartCount"]') ??
                        document.querySelector('[class*="cart-count"]');
                    return el?.textContent?.trim() ?? null;
                });
                const confirmation = cartCount ? ` Cart now shows ${cartCount} item(s).` : "";
                return {
                    content: [{
                            type: "text",
                            text: `Added product ${productId} × ${quantity} to cart.${confirmation}`,
                        }],
                };
            }
            // ── VIEW CART ──────────────────────────────────────────────────────────
            case "woolworths_view_cart": {
                const p = await getPage();
                await p.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                const cart = await p.evaluate(() => {
                    const itemSelectors = [
                        '[class*="CartItem"]',
                        '[data-testid*="cart-item"]',
                        '[class*="cart-item"]',
                    ];
                    let items = [];
                    for (const sel of itemSelectors) {
                        items = Array.from(document.querySelectorAll(sel));
                        if (items.length)
                            break;
                    }
                    const totalEl = document.querySelector('[data-testid="cart-total"]') ??
                        document.querySelector('[class*="CartTotal"]') ??
                        document.querySelector('[class*="order-total"]');
                    const parsed = items.map((item) => {
                        const name = item.querySelector('[class*="ProductName"]')?.textContent?.trim() ??
                            item.querySelector('[class*="product-name"]')?.textContent?.trim() ??
                            item.querySelector("h3, h4")?.textContent?.trim() ??
                            "Unknown";
                        const price = item.querySelector('[class*="Price"]:not([class*="Was"])')?.textContent?.trim() ?? "";
                        const qty = item.querySelector('input[type="number"]')?.value ??
                            item.querySelector('[class*="Quantity"]')?.textContent?.trim() ??
                            "1";
                        const id = item.getAttribute("data-product-id") ??
                            item.querySelector("[data-product-id]")?.getAttribute("data-product-id") ??
                            "";
                        return { name, price, qty, id };
                    });
                    return {
                        items: parsed,
                        total: totalEl?.textContent?.trim() ?? "",
                    };
                });
                if (!cart.items.length) {
                    return { content: [{ type: "text", text: "Your cart is empty (or you are not logged in)." }] };
                }
                const lines = cart.items.map((item, i) => `${i + 1}. ${item.name} × ${item.qty}  ${item.price}${item.id ? `  [ID: ${item.id}]` : ""}`);
                return {
                    content: [{
                            type: "text",
                            text: `Cart (${cart.items.length} items):\n\n${lines.join("\n")}\n\n${cart.total ? `Total: ${cart.total}` : ""}`,
                        }],
                };
            }
            // ── REMOVE FROM CART ───────────────────────────────────────────────────
            case "woolworths_remove_from_cart": {
                const productId = String(args?.productId ?? "");
                if (!productId)
                    return { content: [{ type: "text", text: "productId is required" }] };
                const p = await getPage();
                await p.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                const removed = await p.evaluate((pid) => {
                    // Find the cart item row containing this product ID
                    const row = document.querySelector(`[data-product-id="${pid}"]`) ??
                        document.querySelector(`[data-id="${pid}"]`);
                    if (!row)
                        return false;
                    const removeBtn = row.querySelector('button[aria-label*="Remove" i]') ??
                        row.querySelector('[class*="Remove"]') ??
                        row.querySelector('[data-testid*="remove"]');
                    if (removeBtn) {
                        removeBtn.click();
                        return true;
                    }
                    return false;
                }, productId);
                return {
                    content: [{
                            type: "text",
                            text: removed
                                ? `Removed product ${productId} from cart.`
                                : `Could not find product ${productId} in the cart. It may already have been removed.`,
                        }],
                };
            }
            // ── CLEAR CART ─────────────────────────────────────────────────────────
            case "woolworths_clear_cart": {
                const p = await getPage();
                await p.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                let removedCount = 0;
                // Keep clicking remove buttons until none remain
                for (let attempt = 0; attempt < 50; attempt++) {
                    const btn = await findElement(p, [
                        'button[aria-label*="Remove" i]',
                        '[class*="RemoveItem"]',
                        '[data-testid*="remove-item"]',
                    ]);
                    if (!btn)
                        break;
                    await btn.el.click();
                    await sleep(600);
                    removedCount++;
                }
                return {
                    content: [{
                            type: "text",
                            text: removedCount > 0
                                ? `Cleared cart — removed ${removedCount} item(s).`
                                : "Cart was already empty.",
                        }],
                };
            }
            // ── GET SPECIALS ───────────────────────────────────────────────────────
            case "woolworths_get_specials": {
                const category = String(args?.category ?? "");
                const limit = Math.min(Number(args?.limit ?? 20), 50);
                const p = await getPage();
                // Woolworths NZ specials URL — adjust category slug if needed
                const specialsUrl = category
                    ? `${BASE_URL}/shop/specials/all?inStoreOnly=false&category=${encodeURIComponent(category)}`
                    : `${BASE_URL}/shop/specials/all?inStoreOnly=false`;
                await p.goto(specialsUrl, { waitUntil: "networkidle2", timeout: 30000 });
                await dismissOverlays(p);
                // Reuse the same product tile scraping logic
                const specials = await p.evaluate((lim) => {
                    const selectors = ["[class*='ProductTile']", "[class*='product-tile']", "article[class*='product']"];
                    let tiles = [];
                    for (const sel of selectors) {
                        tiles = Array.from(document.querySelectorAll(sel));
                        if (tiles.length)
                            break;
                    }
                    return tiles.slice(0, lim).map((tile) => {
                        const name = tile.querySelector("[class*='ProductName']")?.textContent?.trim() ??
                            tile.querySelector("h3, h4")?.textContent?.trim() ??
                            "";
                        const price = tile.querySelector("[class*='PriceValue']")?.textContent?.trim() ??
                            tile.querySelector("[class*='Price']:not([class*='Was'])")?.textContent?.trim() ??
                            "";
                        const wasPrice = tile.querySelector("[class*='WasPrice']")?.textContent?.trim() ??
                            tile.querySelector("[class*='was-price']")?.textContent?.trim() ??
                            "";
                        const id = tile.getAttribute("data-product-id") ??
                            tile.querySelector("[data-product-id]")?.getAttribute("data-product-id") ??
                            "";
                        return { name, price, wasPrice, id };
                    }).filter((p) => p.name);
                }, limit);
                if (!specials.length) {
                    return {
                        content: [{
                                type: "text",
                                text: `No specials found${category ? ` in category "${category}"` : ""}. You may need to log in first.`,
                            }],
                    };
                }
                const lines = specials.map((s, i) => {
                    const was = s.wasPrice ? ` (was ${s.wasPrice})` : "";
                    return `${i + 1}. ${s.name} — ${s.price}${was}${s.id ? `  [ID: ${s.id}]` : ""}`;
                });
                return {
                    content: [{
                            type: "text",
                            text: `Current specials${category ? ` (${category})` : ""}:\n\n${lines.join("\n")}`,
                        }],
                };
            }
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            content: [{
                    type: "text",
                    text: `Error in ${name}: ${msg}\n\nIf the browser is having trouble, try setting WOOLWORTHS_HEADLESS=false in .env to see what's happening.`,
                }],
        };
    }
});
// Clean up browser on exit
process.on("SIGINT", async () => {
    if (_browser)
        await _browser.close();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    if (_browser)
        await _browser.close();
    process.exit(0);
});
const transport = new StdioServerTransport();
await server.connect(transport);
