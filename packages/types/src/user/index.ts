export interface User {
  id: string;
  email: string;
  name?: string | null;
  clerkId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
