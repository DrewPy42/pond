import { defineMigration } from '@pond/sdk'

/**
 * Three small tables, all per Space.
 *
 * `budgets` rows mean "from this month on, this category's budget is this amount", so a budget
 * carries forward until it is changed. An amount of 0 means "stop tracking from this month".
 */
export default defineMigration('0001_init', (m) => {
  m.createTable('budgets', {
    columns: {
      category_id: 'text',
      /** YYYY-MM: the first month this amount applies. */
      month: 'text',
      amount_cents: 'integer',
    },
    indexes: [{ columns: ['category_id', 'month'], unique: true }],
  })
  m.createTable('goals', {
    columns: {
      name: 'text',
      target_cents: 'integer',
      /** YYYY-MM-DD, optional. */
      target_date: { type: 'text', nullable: true },
      /** Set: progress is that account's balance. Empty: progress is the contributions below. */
      account_id: { type: 'text', nullable: true },
    },
  })
  m.createTable('contributions', {
    columns: {
      goal_id: 'text',
      /** Signed: a negative amount records money taken back out. */
      amount_cents: 'integer',
      date: 'text',
    },
    indexes: [{ columns: ['goal_id'] }],
  })
})
