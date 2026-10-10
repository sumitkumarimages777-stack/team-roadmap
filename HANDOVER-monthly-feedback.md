# Monthly feedback and the suggestion box: handover notes

## Monthly feedback

| When | What happens |
|---|---|
| Open day (default the **25th**) | The form opens. Everyone gets a 🔔 at 9:30 am (India time), and a pop-up every day after that until they send it. The pop-up's **✍️ Fill it now** button opens the form. |
| Up to the last day of the month | People fill it in at **Administration → 📝 My monthly feedback**. Drafts save automatically. **Send it** locks the form, and their nearest linked senior gets a 🔔. |
| 1st to 10th of the next month | It can still be sent, marked **late**. |
| Review meeting | A senior opens **My Team → Monthly feedback → Read →**, writes notes and action points, and ticks "We've had the meeting". The person gets a 🔔 and sees the notes on their own feedback page. |

**Who can read someone's feedback:**
- the person
- everyone above them in **My Team → Reporting lines**
- super-admins (Sumit)

Drafts are visible to nobody else. An owner in a different branch of the chart can't read it either.

### One-time setup (owners)

1. Go to **My Team → Reporting lines**. For each box, press ✎ and choose its **Linked login**. Boxes that aren't linked show "not linked". A senior only sees people whose boxes are linked below theirs.
2. In **My Team → Monthly feedback → ⚙️ Settings**, set the day the form opens, or switch feedback off.

Only **owners** (and Sumit) can change the org chart now, because the chart decides who reads whose feedback. Admins can no longer edit it.

### The form

1. How was your month? (😣 to 🤩)
2. Biggest wins
3. What didn't go to plan, and why
4. What slowed you down
5. Workload
6. How supported did you feel by your manager? (1 to 5)
7. What you need
8. What you learned
9. A shout-out
10. Top 3 goals for next month
11. Anything for the review meeting

Questions 1, 2, 3, 5 and 10 must be answered before the form can be sent. The questions live in `FB_Q` in `monthly-feedback.js`.

## Suggestion box

- **Administration → 📮 Send to Sumit** (everyone): send a suggestion, improvement, complaint, appreciation or anything else, **anonymously** or **with your name**. Anonymous messages store no sender and only the day, not the time.
- **Administration → 📮 Suggestion box** (super-admins only): sorted into New, Read and Done. Each new message also puts a 🔔 in Sumit's bell.

## Where things live

| Part | Where |
|---|---|
| Screens | `monthly-feedback.js`. The org chart's Linked login field and the My Team tab are in `index.html`. The pop-up's "Fill it now" button is in `notifications.js`. |
| Database | `supabase/stage16a_monthly_feedback.sql` (applied). It contains the tables `monthly_feedback`, `feedback_settings` and `suggestion_box`, plus functions `feedback_*`, `fb_reports` and `suggestion_send`. |
| Reminders | pg_cron job `feedback-reminders` (`0 4 * * *` UTC = 9:30 IST), which calls `feedback_remind()`. |
