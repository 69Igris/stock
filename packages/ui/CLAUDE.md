# @usemoney/ui - CLAUDE.md

## Overview

Shared UI components for UseMoney apps. Built with shadcn/ui, Radix primitives, and Tailwind CSS.

**Package:** `@usemoney/ui`

---

## Exports

```typescript
// Repo convention: per-component subpaths ("./*" -> "./src/*.tsx"), never the root barrel
import { Button } from "@usemoney/ui/button";
import { Card, CardHeader, CardContent } from "@usemoney/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@usemoney/ui/dialog";
```

---

## Components

### Layout

- `Card`, `CardHeader`, `CardContent`, `CardFooter`
- `Dialog`, `DialogContent`, `DialogTrigger`
- `Sheet`, `SheetContent`, `SheetTrigger`
- `Tabs`, `TabsList`, `TabsContent`

### Form

- `Button`
- `Input`
- `Select`
- `Checkbox`
- `Switch`
- `Label`

### Display

- `Badge`
- `Avatar`
- `Skeleton` — the loading affordance (there is no `Spinner`)

### Feedback

- `Toast`, `Toaster`
- `Alert`
- `Progress`

---

## Usage

```typescript
import { Button } from "@usemoney/ui/button";
import { Card, CardHeader, CardContent } from "@usemoney/ui/card";
import { Input } from "@usemoney/ui/input";

<Card>
  <CardHeader>Title</CardHeader>
  <CardContent>
    <Input placeholder="Enter value" />
    <Button>Submit</Button>
  </CardContent>
</Card>
```

---

_Last Updated: July 2026_
