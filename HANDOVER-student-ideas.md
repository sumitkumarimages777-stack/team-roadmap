# Student ideas board: handover notes

## What it is

**https://tools.dubuddy.in/ideas** is a public page where students suggest features and vote for them. It needs no login.

- New ideas wait for the team's approval before anyone else sees them.
- Statuses students see: **In review → Planned → In progress → Completed**, or **Not planned**.
- If a student leaves an email, they get one when their idea is approved, when its status changes, and when the team writes to them.

## Putting it on the website and in the app

- **Website:** link to `https://tools.dubuddy.in/ideas`, for example "💡 Suggest a feature" in the menu or footer.
- **App:** open the same address in an in-app browser (WebView). It's built for phones and follows the phone's dark mode.
- **Later, with login:** the plan is for the app to pass the student's login so votes are tied to real accounts. Today each browser gets one vote per idea, and each browser can send at most 5 ideas a day.

## How the team handles ideas

| Where | What |
|---|---|
| Product space → **🎓 From students** | New ideas: **Approve**, **Merge into…** an existing idea (votes move across), or **Reject** with an optional reason. Needs the **Review student ideas** permission (Owners always have it). |
| Product space → **All ideas** | Approved ideas show 🎓 and their vote count. **✉️** in the last column writes to the student, or to the teammate who pitched it. You can email them, show the message as the team's reply on the board, and tick "shipped". |
| Roadmap columns | Later = In review · Next = Planned · Now = In progress · Won't do = Not planned. Moving an idea updates the board and emails the student. |
| Administration → **💡 My product ideas** | Every teammate sees the status of the ideas they pitched from Social Media → Ideation. |

## Where things live

| Part | Where |
|---|---|
| Public page | `ideas/index.html` |
| Team side | `student-ideas.js` (inbox, sync, ✉️, My product ideas) and `product-pitch.js` (team pitches) |
| Database | `supabase/stage15a_student_ideas.sql` (applied). Tables `student_ideas` and `student_idea_votes`. Students reach them only through the `ideas_*` functions. |
| Emails | Edge Function `idea-mail` (`supabase/functions/idea-mail/index.ts`), "Verify JWT" ON. It uses the same Zoho secrets as `manage-people`. |

The old "💡 Student Ideas" panel that read from JSONBin has been removed from the app. Its JSONBin bin (`6a477b27…`) can be deleted on jsonbin.io.
