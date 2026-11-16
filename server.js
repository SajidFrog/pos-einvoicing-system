require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Localized tax presets for checkout configuration
const TAX_PRESETS = [
  { id: 'bd-standard', label: 'Standard Retail VAT (15%)', rate: 15.0 },
  { id: 'bd-reduced', label: 'Local Trade / Reduced VAT (7.5%)', rate: 7.5 },
  { id: 'essential-goods', label: 'Essential Goods Rate (5%)', rate: 5.0 },
  { id: 'tax-exempt', label: 'Zero-Rated / Exempt (0%)', rate: 0.0 }
];

// Optional PostgreSQL connection (falls back to in-memory store if DATABASE_URL is unset)
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

// Pre-seeded store data for instant local startup
let memoryProducts = [
  { id: 1, sku: 'GRO-101', name: 'Miniket Rice (5kg Pack)', category: 'Groceries', cost_price: 340, selling_price: 395, stock_qty: 18, low_stock_threshold: 6 },
  { id: 2, sku: 'GRO-102', name: 'Soybean Cooking Oil (2L)', category: 'Groceries', cost_price: 310, selling_price: 350, stock_qty: 4, low_stock_threshold: 5 },
  { id: 3, sku: 'BEV-201', name: 'Sylhet Black Tea (400g)', category: 'Beverages', cost_price: 165, selling_price: 210, stock_qty: 12, low_stock_threshold: 5 },
  { id: 4, sku: 'DAI-301', name: 'Full Cream Milk Powder (500g)', category: 'Dairy', cost_price: 380, selling_price: 440, stock_qty: 3, low_stock_threshold: 5 },
  { id: 5, sku: 'HOU-401', name: 'Dishwashing Liquid (500ml)', category: 'Household', cost_price: 95, selling_price: 130, stock_qty: 15, low_stock_threshold: 4 },
  { id: 6, sku: 'STA-501', name: 'A4 Printing Paper Ream', category: 'Stationery', cost_price: 420, selling_price: 510, stock_qty: 2, low_stock_threshold: 4 }
];

let memoryInvoices = [];
let invoiceSequence = 1001;

function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const num = invoiceSequence++;
  return `INV-${year}-${num}`;
}

// Fetch all products
app.get('/api/products', async (req, res) => {
  try {
    if (pool) {
      const { rows } = await pool.query('SELECT * FROM products ORDER BY id ASC');
      return res.json(rows);
    }
    res.json(memoryProducts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products', details: err.message });
  }
});

// Add a new product to inventory
app.post('/api/products', async (req, res) => {
  const { sku, name, category, cost_price, selling_price, stock_qty, low_stock_threshold } = req.body;
  if (!sku || !name || cost_price == null || selling_price == null) {
    return res.status(400).json({ error: 'SKU, name, cost price, and selling price are required.' });
  }

  try {
    if (pool) {
      const { rows } = await pool.query(
        `INSERT INTO products (sku, name, category, cost_price, selling_price, stock_qty, low_stock_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [sku.trim(), name.trim(), category || 'General', Number(cost_price), Number(selling_price), Number(stock_qty || 0), Number(low_stock_threshold || 5)]
      );
      return res.status(201).json(rows[0]);
    }

    const newProduct = {
      id: memoryProducts.length ? Math.max(...memoryProducts.map(p => p.id)) + 1 : 1,
      sku: sku.trim(),
      name: name.trim(),
      category: category || 'General',
      cost_price: Number(cost_price),
      selling_price: Number(selling_price),
      stock_qty: Number(stock_qty || 0),
      low_stock_threshold: Number(low_stock_threshold || 5)
    };
    memoryProducts.push(newProduct);
    res.status(201).json(newProduct);
  } catch (err) {
    res.status(500).json({ error: 'Could not add product', details: err.message });
  }
});

// Quick restock endpoint for low-stock alerts
app.patch('/api/products/:id/restock', async (req, res) => {
  const productId = Number(req.params.id);
  const addQty = Number(req.body.quantity || 10);

  try {
    if (pool) {
      const { rows } = await pool.query(
        'UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 RETURNING *',
        [addQty, productId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Product not found' });
      return res.json(rows[0]);
    }

    const product = memoryProducts.find(p => p.id === productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    product.stock_qty += addQty;
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Restock failed', details: err.message });
  }
});

// Localized tax rates
app.get('/api/tax-rates', (req, res) => {
  res.json(TAX_PRESETS);
});

// Process checkout & generate compliant e-invoice
app.post('/api/invoices', async (req, res) => {
  const { customer_name, tax_region, tax_rate, items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart cannot be empty.' });
  }

  const appliedRate = Number(tax_rate ?? 15);
  const regionLabel = tax_region || `Custom Tax (${appliedRate}%)`;

  try {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let subtotal = 0;
        let totalCost = 0;
        const resolvedItems = [];

        for (const item of items) {
          const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
          const product = rows[0];
          if (!product) throw new Error(`Product ID ${item.product_id} not found.`);
          if (product.stock_qty < item.quantity) {
            throw new Error(`Insufficient stock for ${product.name} (Available:${product.stock_qty}).`);
          }

          const lineTotal = Number((Number(product.selling_price) * item.quantity).toFixed(2));
          const lineCost = Number((Number(product.cost_price) * item.quantity).toFixed(2));
          subtotal += lineTotal;
          totalCost += lineCost;

          await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [item.quantity, product.id]);
          resolvedItems.push({
            product_id: product.id,
            product_name: product.name,
            quantity: item.quantity,
            unit_price: Number(product.selling_price),
            unit_cost: Number(product.cost_price),
            line_total: lineTotal
          });
        }

        const taxAmount = Number((subtotal * (appliedRate / 100)).toFixed(2));
        const totalAmount = Number((subtotal + taxAmount).toFixed(2));
        const totalProfit = Number((subtotal - totalCost).toFixed(2));
        const invoiceNumber = generateInvoiceNumber();

        const invResult = await client.query(
          `INSERT INTO invoices (invoice_number, customer_name, tax_region, tax_rate, subtotal, tax_amount, total_amount, total_profit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [invoiceNumber, customer_name || 'Walk-in Customer', regionLabel, appliedRate, subtotal, taxAmount, totalAmount, totalProfit]
        );
        const createdInvoice = invResult.rows[0];

        for (const rItem of resolvedItems) {
          await client.query(
            `INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, unit_cost, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [createdInvoice.id, rItem.product_id, rItem.product_name, rItem.quantity, rItem.unit_price, rItem.unit_cost, rItem.line_total]
          );
        }

        await client.query('COMMIT');
        return res.status(201).json({ ...createdInvoice, items: resolvedItems });
      } catch (txErr) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: txErr.message });
      } finally {
        client.release();
      }
    }

    // In-memory transaction path
    let subtotal = 0;
    let totalCost = 0;
    const resolvedItems = [];

    for (const item of items) {
      const product = memoryProducts.find(p => p.id === Number(item.product_id));
      if (!product) return res.status(404).json({ error: `Product ID ${item.product_id} not found.` });
      if (product.stock_qty < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${product.name} (Available:${product.stock_qty}).` });
      }

      const lineTotal = Number((product.selling_price * item.quantity).toFixed(2));
      const lineCost = Number((product.cost_price * item.quantity).toFixed(2));
      subtotal += lineTotal;
      totalCost += lineCost;

      resolvedItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        unit_price: product.selling_price,
        unit_cost: product.cost_price,
        line_total: lineTotal
      });
    }

    // Deduct inventory after validation passes
    for (const item of items) {
      const product = memoryProducts.find(p => p.id === Number(item.product_id));
      product.stock_qty -= item.quantity;
    }

    const taxAmount = Number((subtotal * (appliedRate / 100)).toFixed(2));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));
    const totalProfit = Number((subtotal - totalCost).toFixed(2));

    const newInvoice = {
      id: memoryInvoices.length + 1,
      invoice_number: generateInvoiceNumber(),
      customer_name: (customer_name || 'Walk-in Customer').trim(),
      tax_region: regionLabel,
      tax_rate: appliedRate,
      subtotal: Number(subtotal.toFixed(2)),
      tax_amount: taxAmount,
      total_amount: totalAmount,
      total_profit: totalProfit,
      created_at: new Date().toISOString(),
      items: resolvedItems
    };

    memoryInvoices.unshift(newInvoice);
    res.status(201).json(newInvoice);
  } catch (err) {
    res.status(500).json({ error: 'Checkout failed', details: err.message });
  }
});

// List generated e-invoices
app.get('/api/invoices', async (req, res) => {
  try {
    if (pool) {
      const { rows } = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 50');
      return res.json(rows);
    }
    res.json(memoryInvoices);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoices', details: err.message });
  }
});

// Real-time revenue, profit margin, and low-stock analytics
app.get('/api/analytics', async (req, res) => {
  try {
    let products = memoryProducts;
    let invoices = memoryInvoices;

    if (pool) {
      const prodRes = await pool.query('SELECT * FROM products ORDER BY stock_qty ASC');
      const invRes = await pool.query('SELECT * FROM invoices WHERE DATE(created_at) = CURRENT_DATE');
      products = prodRes.rows;
      invoices = invRes.rows;
    }

    const dailyRevenue = invoices.reduce((sum, inv) => sum + Number(inv.total_amount), 0);
    const netSalesExTax = invoices.reduce((sum, inv) => sum + Number(inv.subtotal), 0);
    const dailyProfit = invoices.reduce((sum, inv) => sum + Number(inv.total_profit), 0);
    const taxCollected = invoices.reduce((sum, inv) => sum + Number(inv.tax_amount), 0);
    const profitMarginPct = netSalesExTax > 0 ? Number(((dailyProfit / netSalesExTax) * 100).toFixed(1)) : 0;

    const lowStockItems = products.filter(p => Number(p.stock_qty) <= Number(p.low_stock_threshold));

    res.json({
      daily_revenue: Number(dailyRevenue.toFixed(2)),
      daily_profit: Number(dailyProfit.toFixed(2)),
      tax_collected: Number(taxCollected.toFixed(2)),
      profit_margin_pct: profitMarginPct,
      invoice_count: invoices.length,
      low_stock_items: lowStockItems
    });
  } catch (err) {
    res.status(500).json({ error: 'Analytics calculation failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`POS & E-Invoicing Server running at http://localhost:${PORT}`);
});