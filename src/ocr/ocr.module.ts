import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OcrService } from './ocr.service';
import { OcrProcessor } from './ocr.processor';
import { OCR_QUEUE, OCR_FAILED_QUEUE } from './ocr.constants';

export { OCR_QUEUE, OCR_FAILED_QUEUE };

@Module({
  imports: [BullModule.registerQueue({ name: OCR_QUEUE }, { name: OCR_FAILED_QUEUE })],
  providers: [OcrService, OcrProcessor],
  exports: [OcrService],
})
export class OcrModule {}
