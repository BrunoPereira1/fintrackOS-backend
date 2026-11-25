import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { OcrService, OcrJobPayload } from './ocr.service';
import { OCR_QUEUE } from './ocr.constants';

const mockPayload = (): OcrJobPayload => ({
  userId: 'user-uuid-1',
  fileUrl: 'https://storage.example.com/receipts/nfe-001.xml',
  mimeType: 'application/xml',
});

describe('OcrService', () => {
  let service: OcrService;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OcrService, { provide: getQueueToken(OCR_QUEUE), useValue: queue }],
    }).compile();

    service = module.get(OcrService);
  });

  describe('enqueue', () => {
    it('adiciona o job na fila com os parâmetros corretos', async () => {
      queue.add.mockResolvedValue({ id: 'job-id-1' });

      await service.enqueue(mockPayload());

      expect(queue.add).toHaveBeenCalledWith(
        'process-receipt',
        mockPayload(),
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        }),
      );
    });

    it('retorna o id do job criado', async () => {
      queue.add.mockResolvedValue({ id: 'job-id-42' });

      const jobId = await service.enqueue(mockPayload());

      expect(jobId).toBe('job-id-42');
    });

    it('propaga erro se a fila falhar', async () => {
      queue.add.mockRejectedValue(new Error('Redis connection refused'));

      await expect(service.enqueue(mockPayload())).rejects.toThrow('Redis connection refused');
    });
  });
});
