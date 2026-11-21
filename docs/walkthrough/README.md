# Walkthrough

[`keyturn-walkthrough.svg`](keyturn-walkthrough.svg) is the animation at the top of the main README. It shows the review page while an agent's change is proposed, rejected, proposed again, approved, applied and taken back.

Nothing in it is staged. A script drives a real browser against the review page, with PostgreSQL in a container, and takes a picture at each moment that matters. No model is called: the agent is a script that sends the SQL a model sent in the run the demonstration was taken from, as an ordinary database login.

| Step | What it shows                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------- |
| 1    | An agent asked to clean up test orders deletes 8,114 rows. Nothing is deleted: it is a proposal |
| 2    | The approver sees its size, why it has come to a person, and the rows                           |
| 3    | She rejects it and says why                                                                     |
| 4    | The agent proposes the twelve rows that were meant                                              |
| 5    | Approving asks once more                                                                        |
| 6    | The second key is turned                                                                        |
| 7    | The agent applies it: twelve rows, exactly once                                                 |
| 8    | The approver takes it back, and every row is as it was                                          |

## Make it again

```sh
pnpm exec playwright install chromium-headless-shell
node demo/walkthrough.ts
```

It needs Docker. It writes the SVG in place.

The file is one SVG with the eight pictures inside it and a CSS animation that fades from one to the next, so it plays wherever an image does. The browser is set to UTC and US English, so the pictures show nothing about the machine they were made on.
