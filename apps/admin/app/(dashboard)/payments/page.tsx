import { PaymentsClient } from "./client";

// Payment + subscription admin (MONEY-413). Auth via middleware + each server
// action's requireAdmin().
export default function PaymentsPage() {
  return <PaymentsClient />;
}
