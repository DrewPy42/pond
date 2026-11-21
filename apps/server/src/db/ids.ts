import { v7 } from 'uuid'

/** Every primary key is an app-generated UUIDv7 (CLAUDE.md rule 4). */
export const newId = (): string => v7()
