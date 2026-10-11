import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blogSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  author: z.string(),
  summary: z.string(),
  tags: z.array(z.string()).optional(),
});

// Spanish blog posts (default locale, served at /blog/...)
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: blogSchema,
});

// English blog posts (served at /en/blog/...)
const blogEn = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog-en' }),
  schema: blogSchema,
});

export const collections = { blog, blogEn };
