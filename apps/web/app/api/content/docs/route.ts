import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const posts = await prisma.post.findMany({
      where: {
        contentType: "DOCS",
        status: "PUBLISHED",
      },
      select: {
        id: true,
        title: true,
        excerpt: true,
        postUrl: true,
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { title: "asc" },
      take: 20,
    });

    const transformed = posts.map((post) => ({
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      postUrl: post.postUrl,
      tags: post.tags.map((t) => ({ id: t.tag.id, name: t.tag.name })),
    }));

    return NextResponse.json({ posts: transformed });
  } catch {
    return NextResponse.json({ posts: [] });
  }
}
