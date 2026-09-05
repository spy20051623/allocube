# Getting started

This chapter covers registration, approval, login, and the first steps after you sign in.

## Interface language

Use the language control in the upper-right corner to choose Simplified Chinese or English; the documentation center follows this choice. On first visit, Allocube uses a supported browser language. A manual choice is saved in the current browser and does not sync across devices. Switching language does not translate machine names, reservation notes, or other user-authored content.

## Register an account

1.  On the login page, select "Sign up".
2.  Fill in a unique username, your name, employee ID, and a password that meets the requirements.
3.  If email is enabled, follow the page requirements to enter an address from an allowed domain and verify it with the code sent to you. Administrators control whether it may be left blank.
4.  Submit your registration and wait for a system administrator to approve it.

You can log in with either your username or employee ID; email addresses are not login IDs. When email is disabled, no address is required. When email is enabled but optional, you may register without one, but you will not receive email notifications or be able to reset your password by email.

If an administrator requests changes, update your details from "Profile" and resubmit. While approval is pending, you can only open "Profile" and "Notifications"; you cannot request machine access or create reservations.

## Login

The login page supports two methods:

*   Using a username and password.
*   Using an employee ID and password.

Login sessions last 7 days. If your session expires, log in again. A session cannot be shared across different domains, protocols, or ports.

## Password recovery

If email is enabled and your account has an address, you can request a password reset from the login page. The link can be used once and expires after 30 minutes.

If no email address is available, please contact a system administrator to generate a one-time password reset link. Administrators cannot see your original password.

Changing or resetting your password invalidates old web sessions but does not revoke API tokens. If a token may be compromised, revoke it under "Profile → API tokens".

## First entry into the system

### Browse resources

"Resources" lists all machines, including hardware notes, connection instructions, tags, maintenance status, and your access status. You can request access or leave machines you no longer use.

### View the calendar

Once access is approved, the machine and its resource groups appear in "Calendar". You can filter machines, move between dates, switch between day and week views, choose group or machine mode, and zoom the timeline.

Open Reservations beside the calendar title to find your reservations across machines and locate them in the calendar. Create, edit, and release reservations in the calendar.

### Manage your profile

Open "Profile" from the user menu to manage:

*   Username, name, employee ID, and email.
*   Password.
*   Email notification preferences.
*   API tokens for AI tools, CLIs, and scripts.

Changes to your name and employee ID may require system administrator approval. The token plaintext is only displayed once upon successful creation.

## Notifications

The user menu displays the count of unread notifications. Notifications can be marked as read individually or all at once, and will link to the relevant machine, reservation, or management page when possible.
