# Questions to ask the assistant

These are the questions the assistant's exams ask (`ai/server/eval/exam.js` for a signed-in
company, `ai/server/eval/golden.js` for the browser demo), grouped by what they're for. Each one has
been answered on the live site with citations.

Order and supplier names below are the demo company's (Binh Duong Wood Co., sign in as in the
[README](../README.md)); PO-2291 is its acacia plywood order to Rotterdam from Binh Phu Wood, which is
missing documents. With your own company, use your own order IDs and suppliers.

## Orders

- How many open orders do I have?
- Which of my open orders are in the clear?
- What's the status of PO-2291, and why?
- Which of my orders ships next, and is it ready to go?
- Who supplies PO-2291?
- What HS code is on PO-2291?
- What's my largest open order by value?
- Which markets do my open orders go to, and how many to each?
- Compare my EU and US orders: how many open orders and what total value in each market?

## Missing documents and compliance

- Which of my open orders ship to the EU, and which of them are missing documents?
- Which of my orders could be held at the EU border, and why?
- Which of my suppliers have no plot geolocation on file for my EU orders?
- Which documents is Binh Phu Wood missing for my orders?
- Which documents do I already have on file for PO-2291?
- Which orders ship in the next 14 days and still have missing documents? What should I do first?
- Are any rules changing soon in the markets I ship to?

## Suppliers and risk

- What does Binh Phu Wood buy, and from where?
- Which supplier has the most open orders, and how many?
- If Binh Phu Wood can't send the missing documents before shipping, which orders and how much value
  are at risk?

## Connections (knowledge graph)

- What if Vietnam restricts acacia log exports?
- If Vietnam restricted acacia log exports, which of my orders would be hit?
- Why is PO-2291 linked to acacia?

## What if

- What if PO-2291 went to Japan instead?
- What if PO-2291 shipped a month later?

## Playbook

- How many playbook rules do I have switched on, and what are they?
- Which of my playbook rules apply to PO-2291?

## News watch

- Is there any recent news that affects my materials?
- Is there any news this month that could affect my acacia plywood?
- What did the latest news scan flag?
- When did the news scan last run, and did every source fetch correctly?

## Arithmetic

- What's the total value of my open orders to the European Union?
- PO-2291 is worth $24,000. At a 4.7% duty, how much is the duty?

## Follow-up questions

Ask the second right after the first; it only makes sense with it.

- Which of my open orders ship to the EU? → What are they worth in total?
- Which of my orders are missing documents? → Why is the first one missing them?
- Which of my orders go to Japan? → Which of them ships first, and when?

## How to use ExportMate

- How do I import my orders from a spreadsheet?
- How do I add my own news source?

## In Vietnamese

- Đơn hàng nào của tôi đi EU? (Which of my orders go to the EU?)

## Things it won't make up

It should say it doesn't know or can't find these, not invent an answer.

- What's the status of PO-9999? (no such order)
- What anti-dumping duty rate applies to PO-2291? (no rate on record)

## Browser demo ("Explore the demo")

The browser demo has a sample stock list (SKUs such as PLY-101) and its own sample orders.

- Who supplies PLY-101, and which warehouse is it in?
- How many stock items are in the Plywood category?
- Which items we sell to the EU have no geolocation data on file? List the SKUs.
- Which of our items are PEFC certified?
- Do we have any items certified by the Rainforest Alliance?
- What is the combined stock value of PLY-101 and PLY-102, and the average per SKU?
- How much of our stock is exposed to EUDR news, and which items matter most?
- Why does PO-2291 need action, and what should I do about it?
- Which Plywood items do we sell to the US? → What is their total stock value?
- Chúng ta có bao nhiêu mặt hàng thuộc danh mục Plywood? (How many items are in the Plywood category?)
