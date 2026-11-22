import { createFakeRepos } from '../testing/fakeRepos'
import { repoContract } from '../testing/repoContract'

// The in-memory fakes used by every other test must obey the same contract as the database.
repoContract('fake repos', () => createFakeRepos())
