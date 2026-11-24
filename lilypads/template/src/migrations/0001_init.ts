import { defineMigration } from '@pond/sdk'

/** Migrations are forward-only and never edited once released: add a new one to change the shape. */
export default defineMigration('0001_init', (m) => {
  m.createTable('notes', {
    // `scope` defaults to "space": every row belongs to one Space and Pond keeps Spaces apart for you.
    columns: {
      title: 'text',
      body: { type: 'text', nullable: true },
      done: { type: 'boolean', default: false },
    },
    indexes: [{ columns: ['done'] }],
  })
  // How many transactions this pad has seen, per Space (shows events and upserting).
  m.createTable('stats', {
    columns: { name: 'text', value: { type: 'integer', default: 0 } },
    indexes: [{ columns: ['name'], unique: true }],
  })
})
