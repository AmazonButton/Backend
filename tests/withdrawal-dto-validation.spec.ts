import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RequestWithdrawalDto } from '../src/store-wallet/dto/withdrawal.dto';

async function runTests() {
  console.log('--- Testing RequestWithdrawalDto Validation ---');

  // Case 1: Frontend payload with note, accountNumber, accountHolderName
  const frontendPayload = {
    amount: 200000,
    note: 'Rút doanh thu đợt 1 tháng 10',
    accountNumber: '1680567701',
    accountHolderName: 'TRẦN TẤN PHÁT',
    bankName: 'BIDV',
  };

  const dtoInstance = plainToInstance(RequestWithdrawalDto, frontendPayload);
  const errors = await validate(dtoInstance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    console.error('Validation failed with errors:', errors);
    process.exit(1);
  }

  console.log('✓ Case 1 Passed: Frontend payload with note, accountNumber, accountHolderName passed validation with forbidNonWhitelisted: true');

  // Case 2: Minimal payload with just amount
  const minimalPayload = {
    amount: 50000,
  };
  const minimalDto = plainToInstance(RequestWithdrawalDto, minimalPayload);
  const minErrors = await validate(minimalDto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (minErrors.length > 0) {
    console.error('Minimal validation failed:', minErrors);
    process.exit(1);
  }
  console.log('✓ Case 2 Passed: Minimal payload with 50,000 VND passed validation');

  // Case 3: Amount below 50,000 VND should fail
  const invalidPayload = {
    amount: 40000,
  };
  const invalidDto = plainToInstance(RequestWithdrawalDto, invalidPayload);
  const invErrors = await validate(invalidDto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (invErrors.length === 0) {
    console.error('Expected failure for amount < 50000');
    process.exit(1);
  }
  console.log('✓ Case 3 Passed: Amount < 50,000 VND correctly rejected');

  console.log('ALL WITHDRAWAL DTO VALIDATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
