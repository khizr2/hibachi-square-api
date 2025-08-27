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
    const formattedLineItems = lineItems.map(item => ({
      quantity: String(item.quantity || "1"),
      name: item.name,
      base_price_money: {
        amount: item.price,
        currency: "USD"
      },
      modifiers: item.modifiers ? item.modifiers.map(mod => ({
        name: mod.name,
        base_price_money: {
          amount: mod.price,
          currency: "USD"
        }
      })) : [],
      item_type: "ITEM"
    }));

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
