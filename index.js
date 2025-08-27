const crypto = require("crypto");

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health check
  if (req.method === "GET" && req.url === "/api/healthz") {
    return res.status(200).send("ok");
  }

  // Main endpoint
  if (req.method !== "POST" || req.url !== "/api") {
    return res.status(404).json({ error: "Not found" });
  }

  // Auth check
  if (req.headers["x-api-key"] !== process.env.VAPI_SHARED_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SQUARE_BASE = "https://connect.squareupsandbox.com";
  const SQUARE_VER = "2025-07-16";
  const SANDBOX_DEVICE_ID = "9fa747a2-25ff-48ee-b078-04381f7c828f";

  try {
    const { lineItems = [] } = req.body;

    // Build line items from request
   try {
    // ✅ Parse body robustly (string or object)
    const raw = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});

    // ✅ Accept EITHER full Square payload { order: {...} } OR a simple schema
    let order = raw.order;
// If client sent a full Square order, normalize & inject location
if (order) {
  if (!order.location_id) {
    order.location_id = process.env.SQUARE_LOCATION_ID;
  }
  // Square requires quantity to be a string
  if (Array.isArray(order.line_items)) {
    order.line_items = order.line_items.map(li => ({
      ...li,
      quantity: String(li.quantity ?? "1")
    }));
  }
}

    if (!order) {
      // Expect: raw.lineItems = [{ name, quantity, price, modifiers?[] }]
      const inputItems = Array.isArray(raw.lineItems) ? raw.lineItems : [];

      if (inputItems.length === 0) {
        // Back-compat: allow single-item fields
        const cents = Number(
          raw.amountCents ?? raw.priceCents ?? raw.amount ?? raw?.amount_money?.amount
        );
        if (!Number.isInteger(cents) || cents <= 0) {
          return res.status(400).json({ step: "create-order", error: "Bad amount" });
        }
        inputItems.push({
          name: raw.itemName || "Item",
          quantity: String(raw.qty ?? 1),
          price: cents
        });
      }

      const formattedLineItems = inputItems.map((it) => ({
        name: String(it.name || "Item"),
        quantity: String(it.quantity ?? "1"), // Square requires string
        base_price_money: {
          amount: Number(it.price ?? it.amount ?? 0), // integer cents
          currency: "USD"
        },
        modifiers: Array.isArray(it.modifiers)
          ? it.modifiers.map((m) => ({
              name: String(m.name || "Modifier"),
              base_price_money: {
                amount: Number(m.price ?? 0),
                currency: "USD"
              }
            }))
          : [],
        item_type: "ITEM"
      }));

      order = {
        location_id: process.env.SQUARE_LOCATION_ID, // always from env
        line_items: formattedLineItems,
        taxes: [
          {
            type: "ADDITIVE",
            name: "STATE",
            percentage: String(raw.taxPercent ?? 7.25)
          }
        ],
        state: "OPEN"
      };
    }

    // 1) Create Order
    const orderBody = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        line_items: formattedLineItems,
        taxes: [{
          type: "ADDITIVE",
          name: "STATE",
          percentage: "7.25"
        }],
        state: "OPEN"
      }
    };

    const orderResp = await fetch(`${SQUARE_BASE}/v2/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SQUARE_TOKEN_SANDBOX}`,
        "Square-Version": SQUARE_VER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderBody)
    });

    const orderJson = await orderResp.json();
    
    if (!orderResp.ok) {
      return res.status(orderResp.status).json({ 
        step: "create-order", 
        error: orderJson 
      });
    }

    const orderId = orderJson?.order?.id;
    const dueCents = orderJson?.order?.net_amount_due_money?.amount;

    // 2) Create Terminal Checkout
    const referenceId = `HB-${Math.floor(100000 + Math.random() * 900000)}`;
    const checkoutBody = {
      idempotency_key: crypto.randomUUID(),
      checkout: {
        order_id: orderId,
        amount_money: {
          amount: dueCents,
          currency: "USD"
        },
        reference_id: referenceId,
        device_options: {
          device_id: SANDBOX_DEVICE_ID
        }
      }
    };

    const ckResp = await fetch(`${SQUARE_BASE}/v2/terminals/checkouts`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SQUARE_TOKEN_SANDBOX}`,
        "Square-Version": SQUARE_VER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(checkoutBody)
    });

    const ckJson = await ckResp.json();
    
    if (!ckResp.ok) {
      return res.status(ckResp.status).json({ 
        step: "create-checkout", 
        error: ckJson 
      });
    }

    return res.json({
      ok: true,
      orderId,
      dueCents,
      checkoutId: ckJson?.checkout?.id,
      status: ckJson?.checkout?.status,
      referenceId
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ 
      error: error.message || String(error) 
    });
  }
};
