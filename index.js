const crypto = require("crypto");

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Health check
  if (req.method === "GET" && req.url === "/api/healthz") {
    return res.status(200).send("ok");
  }

  // Main endpoint
  if (req.method !== "POST" || req.url !== "/api") {
    return res.status(404).json({ error: "Not found" });
  }

  // Auth
  if (req.headers["x-api-key"] !== process.env.VAPI_SHARED_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SQUARE_BASE = "https://connect.squareupsandbox.com";
  const SQUARE_VER = "2025-07-16";
  const SANDBOX_DEVICE_ID = "9fa747a2-25ff-48ee-b078-04381f7c828f";

  try {
    // ---------- Parse + normalize input ----------
    const raw = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    let order = raw.order; // pass-through shape if provided

    // If client sent a full Square order, normalize & inject required fields
    if (order) {
      if (!order.location_id) order.location_id = process.env.SQUARE_LOCATION_ID;
      if (!order.state) order.state = "OPEN";
      if (Array.isArray(order.line_items)) {
        order.line_items = order.line_items.map((li) => ({
          ...li,
          quantity: String(li.quantity ?? "1"), // Square requires string
        }));
      }
    }

    // Otherwise accept simple schema and convert to a Square order
    if (!order) {
      // Prefer explicit lineItems; otherwise allow single-item backward-compat
      const inputItems = Array.isArray(raw.lineItems) ? raw.lineItems : [];

      if (inputItems.length === 0) {
        const cents = Number(
          raw.amountCents ?? raw.priceCents ?? raw.amount ?? raw?.amount_money?.amount
        );
        if (!Number.isInteger(cents) || cents <= 0) {
          return res.status(400).json({ step: "create-order", error: "Bad amount" });
        }
        inputItems.push({
          name: raw.itemName || "Item",
          quantity: String(raw.qty ?? 1),
          price: cents,
        });
      }

      const formattedLineItems = inputItems.map((it) => ({
        name: String(it.name || "Item"),
        quantity: String(it.quantity ?? "1"),
        base_price_money: {
          amount: Number(it.price ?? it.amount ?? 0), // integer cents
          currency: "USD",
        },
        modifiers: Array.isArray(it.modifiers)
          ? it.modifiers.map((m) => ({
              name: String(m.name || "Modifier"),
              base_price_money: {
                amount: Number(m.price ?? 0),
                currency: "USD",
              },
            }))
          : [],
        item_type: "ITEM",
      }));

      order = {
        location_id: process.env.SQUARE_LOCATION_ID,
        line_items: formattedLineItems,
        taxes: [
          {
            type: "ADDITIVE",
            name: "STATE",
            percentage: String(raw.taxPercent ?? 7.25),
          },
        ],
        state: "OPEN",
      };
    }

    // ---------- 1) Create Order ----------
    const orderBody = {
      idempotency_key: crypto.randomUUID(),
      order,
    };

    const orderResp = await fetch(`${SQUARE_BASE}/v2/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SQUARE_TOKEN_SANDBOX}`,
        "Square-Version": SQUARE_VER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderBody),
    });

    const orderJson = await orderResp.json();
    if (!orderResp.ok) {
      return res.status(orderResp.status).json({ step: "create-order", error: orderJson });
    }

    const orderId = orderJson?.order?.id;

    // Square-computed due amount (may be 0 in some pass-through cases)
    let dueCents = Number(orderJson?.order?.net_amount_due_money?.amount);

    // ---------- Fallback compute if Square returned 0 ----------
    if (!Number.isInteger(dueCents) || dueCents <= 0) {
      const li = orderJson?.order?.line_items ?? [];
      const subTotal = li.reduce((sum, item) => {
        const base = Number(item?.base_price_money?.amount ?? 0);
        const mods = (item?.modifiers ?? []).reduce(
          (mSum, m) => mSum + Number(m?.base_price_money?.amount ?? 0),
          0
        );
        const qty = Number(String(item?.quantity ?? "1")) || 1;
        return sum + (base + mods) * qty;
      }, 0);

      const taxes = orderJson?.order?.taxes ?? [];
      const pct = taxes.reduce((p, t) => p + Number(t?.percentage ?? 0), 0);
      const taxAmount = Math.round(subTotal * (pct / 100));
      dueCents = subTotal + taxAmount;
    }

    // Safety guard
    if (!Number.isInteger(dueCents) || dueCents <= 0) {
      return res
        .status(400)
        .json({ step: "compute-due", error: "Computed amount must be > 0" });
    }

    // ---------- 2) Create Terminal Checkout ----------
    const referenceId = `HB-${Math.floor(100000 + Math.random() * 900000)}`;
    const checkoutBody = {
      idempotency_key: crypto.randomUUID(),
      checkout: {
        order_id: orderId,
        amount_money: {
          amount: dueCents,
          currency: "USD",
        },
        reference_id: referenceId,
        device_options: {
          device_id: SANDBOX_DEVICE_ID,
        },
      },
    };

    const ckResp = await fetch(`${SQUARE_BASE}/v2/terminals/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SQUARE_TOKEN_SANDBOX}`,
        "Square-Version": SQUARE_VER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(checkoutBody),
    });

    const ckJson = await ckResp.json();
    if (!ckResp.ok) {
      return res.status(ckResp.status).json({ step: "create-checkout", error: ckJson });
    }

    return res.json({
      ok: true,
      orderId,
      dueCents,
      checkoutId: ckJson?.checkout?.id,
      status: ckJson?.checkout?.status,
      referenceId,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || String(error) });
  }
};
