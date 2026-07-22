# BHS operation field policy

## Existing-product stock receipt

Required:

- one unambiguous product match: barcode, SKU, or exact name
- incoming quantity
- incoming unit cost

Recommended:

- supplier
- supplier contact when the supplier is new
- expiry date for food, drink, dairy, chilled, fresh, bakery, meat, or egg products
- location when the storage location changes

On confirmation, add the incoming quantity to existing stock, record a `WECHAT` inventory movement, and calculate weighted average cost:

`(old stock × old cost + incoming quantity × incoming cost) ÷ new stock`

Do not overwrite a nearer existing expiry date with a later incoming date.

## New product

Required before confirmation:

- product name
- initial stock
- purchase cost
- sale price

Default the unit to `件` only when the user gives no usable unit. Never default a missing price or cost to zero in a conversational workflow.

Recommended:

- barcode or SKU
- category, brand, and specification
- supplier and contact
- stock warning threshold
- location
- expiry date for perishable goods

## Queries and analysis

Use only the live BHS context supplied for the current turn. If sales are not connected, say so before interpreting revenue or profit as zero. Separate confirmed data from recommendations.

## Safety

- All writes require confirmation.
- Product matching must precede a stock receipt.
- Preserve an audit trail for writes.
- Keep archived products visible to historical analysis but exclude them from active inventory.
- Do not reveal credentials or internal runtime metadata.
