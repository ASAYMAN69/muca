import { z } from 'zod';

import { ToolError, type MucaTool, type ToolResult } from './registry.js';

/**
 * Muca's tool set.
 *
 * These are placeholder tools for the hackathon skeleton: they exercise the
 * full MCP round trip (discovery -> validation -> execution -> confirmation)
 * without depending on any external service. Swap the bodies for the real
 * use case once it is decided — the plumbing stays the same.
 */

/* -------------------------------------------------------------------------- */
/* State shared between tool calls                                            */
/* -------------------------------------------------------------------------- */

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  tags: string[];
}

/** In-memory store. Process-local and non-durable — fine for a demo. */
class NoteStore {
  private readonly notes = new Map<string, Note>();
  private nextId = 1;

  create(title: string, body: string, tags: string[]): Note {
    const id = `note_${this.nextId++}`;
    const note: Note = {
      id,
      title,
      body,
      tags,
      createdAt: new Date().toISOString(),
    };
    this.notes.set(id, note);
    return note;
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  all(): Note[] {
    return [...this.notes.values()];
  }

  delete(id: string): boolean {
    return this.notes.delete(id);
  }

  clear(): number {
    const count = this.notes.size;
    this.notes.clear();
    return count;
  }
}

export const noteStore = new NoteStore();

/* -------------------------------------------------------------------------- */
/* Helper                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds a tool with its argument types inferred from the Zod schema.
 * The handler receives the parsed, typed arguments.
 */
function defineTool<Shape extends z.ZodRawShape>(config: {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<Shape>;
  destructive?: boolean;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
  ) => Promise<ToolResult> | ToolResult;
}): MucaTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.schema,
    destructive: config.destructive ?? false,
    handler: config.handler as MucaTool['handler'],
  };
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const createNoteArgs = z.object({
  title: z.string().min(1, 'title must not be empty').max(120),
  body: z.string().max(4000).default(''),
  tags: z.array(z.string().min(1)).max(10).default([]),
});

const listNotesArgs = z.object({
  tag: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

const getNoteArgs = z.object({
  id: z.string().min(1),
});

const deleteNoteArgs = z.object({
  id: z.string().min(1),
});

const echoArgs = z.object({
  message: z.string().min(1).max(500),
  repeat: z.number().int().min(1).max(5).default(1),
});

const weatherArgs = z.object({
  city: z.string().min(1).max(80),
  unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
});

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

export function createTools(): MucaTool[] {
  return [
    defineTool({
      name: 'echo',
      title: 'Echo',
      description:
        'Repeat a short message back to the user. Useful for verifying that tool calls work end to end.',
      schema: echoArgs,
      handler: (args) => ({
        summary: Array.from({ length: args.repeat }, () => args.message).join(' '),
        data: { message: args.message, repeat: args.repeat },
      }),
    }),

    defineTool({
      name: 'create_note',
      title: 'Create note',
      description:
        'Save a note with a title, optional body and optional tags. Returns the created note id.',
      schema: createNoteArgs,
      handler: (args) => {
        const note = noteStore.create(args.title, args.body, args.tags);
        return {
          summary: `Created note "${note.title}" with id ${note.id}.`,
          data: note,
        };
      },
    }),

    defineTool({
      name: 'list_notes',
      title: 'List notes',
      description:
        'List saved notes, optionally filtered by a single tag. Returns the most recent notes first.',
      schema: listNotesArgs,
      handler: (args) => {
        const filtered = args.tag
          ? noteStore.all().filter((note) => note.tags.includes(args.tag!))
          : noteStore.all();
        const notes = filtered
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, args.limit);
        return {
          summary:
            notes.length === 0
              ? 'No notes found.'
              : `Found ${notes.length} note(s): ${notes
                  .map((n) => `${n.id} "${n.title}"`)
                  .join(', ')}`,
          data: { count: notes.length, notes },
        };
      },
    }),

    defineTool({
      name: 'get_note',
      title: 'Get note',
      description: 'Fetch one note by its id.',
      schema: getNoteArgs,
      handler: (args) => {
        const note = noteStore.get(args.id);
        if (!note) {
          throw new ToolError(`No note with id ${args.id}.`);
        }
        return {
          summary: `Note ${note.id}: "${note.title}"\n${note.body}`,
          data: note,
        };
      },
    }),

    defineTool({
      name: 'delete_note',
      title: 'Delete note',
      description:
        'Permanently delete a note by id. This is destructive and requires user confirmation.',
      schema: deleteNoteArgs,
      destructive: true,
      handler: (args) => {
        const note = noteStore.get(args.id);
        if (!note) {
          throw new ToolError(`No note with id ${args.id}.`);
        }
        noteStore.delete(args.id);
        return {
          summary: `Deleted note ${args.id} ("${note.title}").`,
          data: { id: args.id, deleted: true },
        };
      },
    }),

    defineTool({
      name: 'clear_notes',
      title: 'Clear all notes',
      description:
        'Delete every saved note. This is destructive and requires user confirmation.',
      schema: z.object({}),
      destructive: true,
      handler: () => {
        const count = noteStore.clear();
        return {
          summary: `Deleted ${count} note(s).`,
          data: { deleted: count },
        };
      },
    }),

    defineTool({
      name: 'get_weather',
      title: 'Get weather',
      description:
        'Return a deterministic mock weather reading for a city. Stands in for a real weather API during the demo.',
      schema: weatherArgs,
      handler: (args) => {
        // Deterministic pseudo-weather so the demo is reproducible.
        const seed = [...args.city.toLowerCase()].reduce(
          (acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973,
          7,
        );
        const celsius = (seed % 35) - 5;
        const temperature =
          args.unit === 'fahrenheit' ? Math.round((celsius * 9) / 5 + 32) : celsius;
        const conditions = ['clear', 'cloudy', 'light rain', 'windy', 'overcast'];
        const condition = conditions[seed % conditions.length];
        return {
          summary: `${args.city}: ${temperature}°${args.unit === 'fahrenheit' ? 'F' : 'C'}, ${condition}.`,
          data: {
            city: args.city,
            temperature,
            unit: args.unit,
            condition,
            mock: true,
          },
        };
      },
    }),
  ];
}
