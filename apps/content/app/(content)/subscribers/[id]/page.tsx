"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  Loader2,
  Trash2,
  Mail,
  MailX,
  UserPlus,
  UserMinus,
  Save,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { Input } from "@usemoney/ui/input";
import { Label } from "@usemoney/ui/label";
import { Textarea } from "@usemoney/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Switch } from "@usemoney/ui/switch";
import { Separator } from "@usemoney/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@usemoney/ui/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@usemoney/ui/alert-dialog";
import {
  getSubscriberById,
  updateSubscriber,
  deleteSubscriber,
  updateSubscriberSegments,
  getSubscriberTimeline,
  type SubscriberDetail,
  type TimelineEvent,
} from "@/lib/actions";
import { toast } from "sonner";
import { getInitials, getAvatarColor } from "./avatar-utils";

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  PENDING:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  UNSUBSCRIBED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

const ALL_SEGMENTS = ["free", "paid", "security"];

export default function SubscriberDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [subscriber, setSubscriber] = useState<SubscriberDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingSegments, setSavingSegments] = useState(false);

  // Editable fields
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLocation, setEditLocation] = useState("");

  // Initial values for dirty tracking
  const [initialName, setInitialName] = useState("");
  const [initialNote, setInitialNote] = useState("");
  const [initialLocation, setInitialLocation] = useState("");

  const isDirty =
    editName !== initialName ||
    editNote !== initialNote ||
    editLocation !== initialLocation;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subResult, timelineResult] = await Promise.all([
        getSubscriberById(id),
        getSubscriberTimeline(id),
      ]);

      if (subResult.success && subResult.data) {
        const sub = subResult.data;
        setSubscriber(sub);
        setEditName(sub.name || "");
        setEditNote(sub.note || "");
        setEditLocation(sub.location || "");
        setInitialName(sub.name || "");
        setInitialNote(sub.note || "");
        setInitialLocation(sub.location || "");
      } else {
        setError(subResult.error || "Subscriber not found");
      }

      if (timelineResult.success && timelineResult.data) {
        setTimeline(timelineResult.data);
      }
    } catch {
      setError("Failed to load subscriber");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      const result = await updateSubscriber(id, {
        name: editName,
        note: editNote,
        location: editLocation,
      });
      if (result.success) {
        toast.success("Subscriber updated");
        setInitialName(editName);
        setInitialNote(editNote);
        setInitialLocation(editLocation);
      } else {
        toast.error(result.error || "Failed to update");
      }
    } catch {
      toast.error("Failed to update subscriber");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await deleteSubscriber(id);
      if (result.success) {
        toast.success("Subscriber deleted");
        router.push("/subscribers");
      } else {
        toast.error(result.error || "Failed to delete");
        setDeleting(false);
      }
    } catch {
      toast.error("Failed to delete subscriber");
      setDeleting(false);
    }
  };

  const handleSegmentToggle = async (segment: string, checked: boolean) => {
    if (!subscriber) return;
    const newSegments = checked
      ? [...subscriber.segments, segment]
      : subscriber.segments.filter((s) => s !== segment);

    setSavingSegments(true);
    try {
      const result = await updateSubscriberSegments(id, newSegments);
      if (result.success) {
        setSubscriber({ ...subscriber, segments: newSegments });
        toast.success("Segments updated");
      } else {
        toast.error(result.error || "Failed to update segments");
      }
    } catch {
      toast.error("Failed to update segments");
    } finally {
      setSavingSegments(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !subscriber) {
    return (
      <div className="p-8">
        <Link
          href="/subscribers"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to subscribers
        </Link>
        <div className="flex flex-col items-center justify-center h-48">
          <p className="text-muted-foreground">{error || "Not found"}</p>
        </div>
      </div>
    );
  }

  const timelineIcon = (type: TimelineEvent["type"]) => {
    switch (type) {
      case "subscribed":
        return <UserPlus className="size-4 text-green-500" />;
      case "unsubscribed":
        return <UserMinus className="size-4 text-red-500" />;
      case "email_sent":
        return <Mail className="size-4 text-blue-500" />;
      case "email_failed":
        return <MailX className="size-4 text-red-500" />;
      case "email_bounced":
        return <MailX className="size-4 text-orange-500" />;
      default:
        return <Mail className="size-4 text-muted-foreground" />;
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link
          href="/subscribers"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to subscribers
        </Link>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={!isDirty || saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <Save className="size-4 mr-2" />
            )}
            Save
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-destructive">
                <Trash2 className="size-4 mr-2" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete subscriber</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete {subscriber.email}? This will
                  also remove them from all Resend audiences. This action cannot
                  be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  disabled={deleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleting ? (
                    <>
                      <Loader2 className="size-4 mr-2 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    "Delete"
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Subscriber Identity */}
      <div className="flex items-center gap-4 mb-8">
        <Avatar className="h-14 w-14">
          {subscriber.imageUrl && (
            <AvatarImage
              src={subscriber.imageUrl}
              alt={subscriber.name || subscriber.email}
            />
          )}
          <AvatarFallback
            className={`${getAvatarColor(subscriber.email)} text-white text-lg`}
          >
            {getInitials(subscriber.name, subscriber.email)}
          </AvatarFallback>
        </Avatar>
        <div>
          <h1 className="text-xl font-semibold">
            {subscriber.name || subscriber.email}
          </h1>
          <p className="text-sm text-muted-foreground">{subscriber.email}</p>
          <div className="flex items-center gap-2 mt-1">
            <Badge className={statusColors[subscriber.status] || ""}>
              {subscriber.status.charAt(0) +
                subscriber.status.slice(1).toLowerCase()}
            </Badge>
            {subscriber.subscribedAt && (
              <span className="text-xs text-muted-foreground">
                Active since{" "}
                {format(new Date(subscriber.subscribedAt), "MMM d, yyyy")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column (2/3) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Details Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Name</Label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Subscriber name"
                  maxLength={200}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">Email</Label>
                <Input value={subscriber.email} disabled className="bg-muted" />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">Location</Label>
                <Input
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value)}
                  placeholder="City, Country"
                  maxLength={200}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">
                  Note{" "}
                  <span className="text-muted-foreground font-normal">
                    (not visible to subscriber)
                  </span>
                </Label>
                <Textarea
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="Internal notes about this subscriber..."
                  maxLength={500}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {editNote.length}/500
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Email Activity Card */}
          {subscriber.emailActivity && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Email Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="text-center p-3 rounded-lg bg-muted/50">
                    <p className="text-2xl font-bold">
                      {subscriber.emailActivity.sent}
                    </p>
                    <p className="text-xs text-muted-foreground">Sent</p>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-muted/50">
                    <p className="text-2xl font-bold">
                      {subscriber.emailActivity.failed}
                    </p>
                    <p className="text-xs text-muted-foreground">Failed</p>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-muted/50">
                    <p className="text-2xl font-bold">
                      {subscriber.emailActivity.bounced}
                    </p>
                    <p className="text-xs text-muted-foreground">Bounced</p>
                  </div>
                </div>
                {subscriber.emailActivity.lastEmail && (
                  <div className="text-sm">
                    <Separator className="mb-3" />
                    <p className="text-muted-foreground">Last email</p>
                    <p className="font-medium mt-1">
                      &quot;{subscriber.emailActivity.lastEmail.subject}&quot;
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {subscriber.emailActivity.lastEmail.status} &middot;{" "}
                      {format(
                        new Date(subscriber.emailActivity.lastEmail.sentAt),
                        "MMM d, yyyy",
                      )}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Activity Timeline */}
          {timeline.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {timeline.map((event, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="mt-0.5">{timelineIcon(event.type)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{event.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {format(
                            new Date(event.timestamp),
                            "MMM d, yyyy 'at' h:mm a",
                          )}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column (1/3) */}
        <div className="space-y-6">
          {/* Newsletters Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Newsletters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {ALL_SEGMENTS.map((segment) => (
                <div
                  key={segment}
                  className="flex items-center justify-between"
                >
                  <Label className="text-sm capitalize">{segment}</Label>
                  <Switch
                    checked={subscriber.segments.includes(segment)}
                    onCheckedChange={(checked) =>
                      handleSegmentToggle(segment, checked)
                    }
                    disabled={savingSegments}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Metadata Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground">Source</p>
                <p className="text-sm">{subscriber.source || "Unknown"}</p>
              </div>
              {subscriber.subscribedAt && (
                <div>
                  <p className="text-xs text-muted-foreground">Subscribed</p>
                  <p className="text-sm">
                    {format(new Date(subscriber.subscribedAt), "MMM d, yyyy")}
                  </p>
                </div>
              )}
              {subscriber.unsubscribedAt && (
                <div>
                  <p className="text-xs text-muted-foreground">Unsubscribed</p>
                  <p className="text-sm">
                    {format(new Date(subscriber.unsubscribedAt), "MMM d, yyyy")}
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="text-sm">
                  {format(new Date(subscriber.createdAt), "MMM d, yyyy")}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
