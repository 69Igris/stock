"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import {
  Loader2,
  Users,
  Shield,
  Crown,
  Pencil,
  UserPlus,
  Mail,
  Clock,
  XCircle,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@usemoney/ui/avatar";
import { Input } from "@usemoney/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  listAuthors,
  updateAuthorRole,
  getCurrentAuthor,
  inviteAuthor,
  listInvites,
  revokeInvite,
} from "@/lib/actions";
import { toast } from "sonner";

type AuthorWithPostCount = {
  id: string;
  clerkId: string;
  name: string | null;
  username: string;
  email: string;
  imageUrl: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  _count: {
    posts: number;
  };
};

type Invite = {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
};

const roleColors: Record<string, string> = {
  OWNER: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  ADMIN:
    "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  WRITER: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
};

const roleIcons: Record<string, React.ReactNode> = {
  OWNER: <Crown className="size-3" />,
  ADMIN: <Shield className="size-3" />,
  WRITER: <Pencil className="size-3" />,
};

export default function MembersPage() {
  const [authors, setAuthors] = useState<AuthorWithPostCount[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("WRITER");
  const [inviting, setInviting] = useState(false);

  const canManage = currentUserRole === "OWNER" || currentUserRole === "ADMIN";
  const isOwner = currentUserRole === "OWNER";

  const fetchData = async () => {
    setLoading(true);
    try {
      const [authorsResult, currentResult, invitesResult] = await Promise.all([
        listAuthors(),
        getCurrentAuthor(),
        listInvites(),
      ]);

      if (authorsResult.success && authorsResult.data) {
        setAuthors(authorsResult.data as unknown as AuthorWithPostCount[]);
      } else {
        setError(authorsResult.error || "Failed to load members");
      }

      if (currentResult.success && currentResult.data) {
        setCurrentUserRole(
          (currentResult.data as unknown as AuthorWithPostCount).role,
        );
      }

      if (invitesResult.success && invitesResult.data) {
        setInvites(invitesResult.data as unknown as Invite[]);
      }
    } catch {
      setError("Failed to load members");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRoleChange = async (authorId: string, newRole: string) => {
    setUpdatingId(authorId);
    try {
      const result = await updateAuthorRole(
        authorId,
        newRole as "ADMIN" | "OWNER" | "WRITER",
      );

      if (result.success && result.data) {
        toast.success("Role updated");
        setAuthors((prev) =>
          prev.map((a) => (a.id === authorId ? { ...a, role: newRole } : a)),
        );
      } else {
        toast.error(result.error || "Failed to update role");
      }
    } catch {
      toast.error("Failed to update role");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setInviting(true);
    try {
      const result = await inviteAuthor(
        inviteEmail.trim(),
        inviteRole as "ADMIN" | "WRITER",
      );

      if (result.success) {
        toast.success(result.message || "Invite sent");
        setInviteEmail("");
        setInviteRole("WRITER");
        fetchData();
      } else {
        toast.error(result.error || "Failed to send invite");
      }
    } catch {
      toast.error("Failed to send invite");
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    toast("Revoke this invite?", {
      action: {
        label: "Revoke",
        onClick: async () => {
          setRevokingId(inviteId);
          try {
            const result = await revokeInvite(inviteId);
            if (result.success) {
              toast.success("Invite revoked");
              setInvites((prev) => prev.filter((i) => i.id !== inviteId));
            } else {
              toast.error(result.error || "Failed to revoke invite");
            }
          } catch {
            toast.error("Failed to revoke invite");
          } finally {
            setRevokingId(null);
          }
        },
      },
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Users className="h-16 w-16 text-muted-foreground mb-4" />
        <p className="text-xl text-muted-foreground mb-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Members</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {authors.length} {authors.length === 1 ? "member" : "members"}
          </p>
        </div>
      </div>

      {/* Invite Form - only for OWNER/ADMIN */}
      {canManage && (
        <Card className="mb-6">
          <CardContent className="p-4">
            <form onSubmit={handleInvite} className="flex items-center gap-3">
              <UserPlus className="size-5 text-muted-foreground flex-shrink-0" />
              <Input
                type="email"
                placeholder="Enter email to invite..."
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1 h-8 text-sm"
                required
              />
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="w-[120px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WRITER">Writer</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" size="sm" disabled={inviting}>
                {inviting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Invite"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Pending Invites */}
      {canManage && invites.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
            <Clock className="size-4" />
            Pending Invites ({invites.length})
          </h2>
          <div className="space-y-2">
            {invites.map((invite) => (
              <Card
                key={invite.id}
                className="border-dashed hover:bg-accent/50 transition-colors"
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>
                        <Mail className="size-4" />
                      </AvatarFallback>
                    </Avatar>

                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{invite.email}</p>
                      <p className="text-xs text-muted-foreground">
                        Expires{" "}
                        {format(new Date(invite.expiresAt), "MMM d, yyyy")}
                      </p>
                    </div>

                    <Badge
                      className={`${roleColors[invite.role] || ""} flex items-center gap-1`}
                    >
                      {roleIcons[invite.role]}
                      {invite.role.charAt(0) +
                        invite.role.slice(1).toLowerCase()}
                    </Badge>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(invite.id)}
                      disabled={revokingId === invite.id}
                      title="Revoke invite"
                    >
                      {revokingId === invite.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <XCircle className="size-4 text-red-500" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Active Members */}
      <div className="space-y-3">
        {authors.map((author) => (
          <Card
            key={author.id}
            className="hover:bg-accent/50 transition-colors"
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={author.imageUrl || ""} />
                  <AvatarFallback>
                    {author.name?.charAt(0) ||
                      author.username.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {author.name || author.username}
                  </p>
                  <p className="text-sm text-muted-foreground truncate">
                    {author.email}
                  </p>
                </div>

                <div className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
                  <div className="text-center">
                    <p className="font-medium text-foreground">
                      {author._count.posts}
                    </p>
                    <p className="text-xs">Posts</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs">
                      Joined {format(new Date(author.createdAt), "MMM d, yyyy")}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isOwner && author.role !== "OWNER" ? (
                    <Select
                      value={author.role.toLowerCase()}
                      onValueChange={(value) =>
                        handleRoleChange(author.id, value.toUpperCase())
                      }
                      disabled={updatingId === author.id}
                    >
                      <SelectTrigger className="w-[120px] h-8 text-xs">
                        {updatingId === author.id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <SelectValue />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="writer">Writer</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="owner">Owner</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge
                      className={`${roleColors[author.role] || ""} flex items-center gap-1`}
                    >
                      {roleIcons[author.role]}
                      {author.role.charAt(0) +
                        author.role.slice(1).toLowerCase()}
                    </Badge>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
