# Notification Data Layer

> 17 nodes

## Key Concepts

- **db/notifications.ts** (16 connections) — `lib/db/notifications.ts`
- **notifications-logic.ts** (10 connections) — `lib/db/notifications-logic.ts`
- **notifications.test.ts** (9 connections) — `__tests__/db/notifications.test.ts`
- **buildUnreadWhere()** (5 connections) — `lib/db/notifications-logic.ts`
- **buildOwnedNotificationWhere()** (4 connections) — `lib/db/notifications-logic.ts`
- **buildReadWhere()** (4 connections) — `lib/db/notifications-logic.ts`
- **buildUserNotificationsWhere()** (4 connections) — `lib/db/notifications-logic.ts`
- **mapNotificationRow()** (4 connections) — `lib/db/notifications-logic.ts`
- **getNotifications()** (3 connections) — `lib/db/notifications.ts`
- **NOTIFICATION_SELECT** (3 connections) — `lib/db/notifications-logic.ts`
- **NotificationItem** (2 connections) — `lib/db/notifications-logic.ts`
- **RawNotificationRow** (2 connections) — `lib/db/notifications-logic.ts`
- **clearReadNotifications()** (2 connections) — `lib/db/notifications.ts`
- **getUnreadCount()** (2 connections) — `lib/db/notifications.ts`
- **markAllAsRead()** (2 connections) — `lib/db/notifications.ts`
- **markAsRead()** (2 connections) — `lib/db/notifications.ts`
- **rawRow()** (1 connections) — `__tests__/db/notifications.test.ts`

## Relationships

- [Broker Connection Routes](Broker_Connection_Routes.md) (2 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/db/notifications.test.ts`
- `lib/db/notifications-logic.ts`
- `lib/db/notifications.ts`

## Audit Trail

- EXTRACTED: 38 (97%)
- INFERRED: 1 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*