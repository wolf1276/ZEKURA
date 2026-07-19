import { openDatabase } from './src/db/sqlite.js';
import { OrderRepository } from './src/db/repositories/OrderRepository.js';

const db = openDatabase('./data/matcher.db');
const repo = new OrderRepository(db);
try {
  repo.insert({
    id: 'aa'.repeat(32),
    asset: '40c9bb75b7302c92ca27814fcb744529e5b4eb7d10a5fa5ef8bf6e369c8acd32',
    side: 'BUY',
    price: 1n,
    amount: 10n,
    commitment: 'bb'.repeat(32),
    ownerId: 'cc'.repeat(32),
    signature: 'dd'.repeat(32),
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9999999999n,
    payoutAddress: null,
  });
  console.log('insert OK');
} catch (e) {
  console.error('INSERT FAILED', e);
}
