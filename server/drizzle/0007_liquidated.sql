-- The alpha's "bankrupt" status is what the beta calls liquidation (see CONTEXT.md).
UPDATE "companies" SET "status" = 'liquidated' WHERE "status" = 'bankrupt';
