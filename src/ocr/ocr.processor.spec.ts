import { Test, TestingModule } from '@nestjs/testing';
import { OcrProcessor } from './ocr.processor';
import { OcrJobPayload } from './ocr.service';
import { Job } from 'bullmq';

const mockJob = (data: OcrJobPayload): Job<OcrJobPayload> =>
  ({
    id: 'job-id-1',
    data,
  }) as Job<OcrJobPayload>;

describe('OcrProcessor', () => {
  let processor: OcrProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OcrProcessor],
    }).compile();

    processor = module.get(OcrProcessor);
  });

  describe('process', () => {
    it('processa o job sem lançar erro', async () => {
      const job = mockJob({
        userId: 'user-uuid-1',
        fileUrl: 'https://storage.example.com/receipts/nfe-001.xml',
        mimeType: 'application/xml',
      });

      await expect(processor.process(job)).resolves.not.toThrow();
    });

    it('processa jobs com diferentes mimeTypes sem erro', async () => {
      const xmlJob = mockJob({
        userId: 'user-uuid-1',
        fileUrl: 'https://storage.example.com/receipts/nfe.xml',
        mimeType: 'application/xml',
      });

      const pdfJob = mockJob({
        userId: 'user-uuid-2',
        fileUrl: 'https://storage.example.com/receipts/receipt.pdf',
        mimeType: 'application/pdf',
      });

      await expect(processor.process(xmlJob)).resolves.not.toThrow();
      await expect(processor.process(pdfJob)).resolves.not.toThrow();
    });
  });
});
