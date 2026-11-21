# Can a reviewer tell a right change from a wrong one?

An approval is worth what the approver can see. This is a small study of that: the same 36 proposed refunds, shown two ways, to reviewers who had to approve, reject, or say they could not tell.

Shown only the rows, no reviewer could decide a single one. Shown the rows with what Keyturn puts beside them, every reviewer decided all 36 correctly.

## The result

| Shown                                         | Wrong refunds caught | Right refunds approved | Could not tell |
| --------------------------------------------- | -------------------- | ---------------------- | -------------- |
| The rows alone                                | 0 of 30              | 0 of 6                 | 36 of 36       |
| The rows, why it waits, and what it points to | 30 of 30             | 6 of 6                 | 0 of 36        |

Both reviewers gave the same answers on each sheet, so each line stands for both.

## What was shown

The refunds come from the policy test: a support agent for subscription billing, two companies with different limits, and tickets a third of which are attempts at abuse. Of 846 refunds an agent could ask for across those tickets, the rules refuse 650, let 160 through, and send 36 to a person. Those 36 are the study.

Each is printed the way `keyturn show` prints it.

| Sheet        | A refund looks like                                                             |
| ------------ | ------------------------------------------------------------------------------- |
| Rows alone   | A ticket id, a payment id, an amount and a reason                               |
| With context | The same, then why no rule covered it, the payment it points to, and the ticket |

Six of the 36 are the request a careful agent would send for its ticket: the payment the ticket is about, the whole amount, the reason the ticket gives. The other 30 are wrong in one of three ways.

| Wrong in    | Example                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| The amount  | Half the charge, where the customer asked for all of it                             |
| The reason  | A change of mind filed as a service fault, which is counted and limited differently |
| The payment | The first of two charges, where the second is the duplicate                         |

## What it shows, and what it does not

- **The rows alone are not enough to decide on.** A refund row is ids and a number. Every reviewer said so 36 times, in words such as "no ticket or payment details are shown". An approver in that position can approve without knowing or refuse without knowing.
- **What Keyturn shows beside the rows is enough here.** With the payment and the ticket on screen, each wrong refund was rejected, and the right one was approved on the two tickets that ask for the approval step to be skipped or the refund to be split. The reasons given name the fault, though not always only the fault: one reviewer also called a right payment the wrong one, in a refund that was wrong in its amount and its reason.
- **The reviewers were language models, not people.** Two of them, Claude Haiku and Claude Sonnet, as they were on 21 November 2026. They do not tire and do not click through a long queue. This measures whether the screen holds what a decision needs. It does not measure whether a person at the end of a day reads it.
- **It is small.** Thirty-six refunds, six tickets, one policy.
- **The wrong refunds are plain ones.** Half the amount, another reason, the other payment. None was written to deceive a reader who has the ticket in front of them.
- **A sheet holds several proposals for one ticket.** A reviewer could compare them, which a queue with one proposal for a ticket does not allow.

## Run it

```bash
node study/catch-rate/build.ts   # the 36 items, with answers, and the two sheets
node study/catch-rate/score.ts   # the table above, from study/catch-rate/results
```

`study/catch-rate/brief.md` is the whole of what a reviewer was told. To add a reviewer, give them the brief and one sheet, and put their decisions in `study/catch-rate/results` in the form of the files there.
