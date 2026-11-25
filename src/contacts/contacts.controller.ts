import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TierGuard } from '../auth/guards/tier.guard';
import { RequiresTier } from '../auth/decorators/requires-tier.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Plan } from '../users/enums/plan.enum';
import { User } from '../users/entities/user.entity';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { ContactResponseDto, PaginatedContactsResponseDto } from './dto/contact-response.dto';
import { ContactMapper } from './contact.mapper';

@ApiTags('contacts')
@ApiBearerAuth('firebase-jwt')
// Plano por método: rebaixado ainda lê seus contatos; criar/editar/remover exige PREMIUM
@UseGuards(AuthGuard, TierGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Post()
  @RequiresTier(Plan.PREMIUM)
  @ApiCreatedResponse({ type: ContactResponseDto })
  @ApiConflictResponse({ description: 'Já existe contato do usuário com este e-mail' })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateContactDto,
  ): Promise<ContactResponseDto> {
    return ContactMapper.toDto(await this.contactsService.create(user.id, dto));
  }

  @Get()
  @ApiOkResponse({ type: PaginatedContactsResponseDto })
  async findAll(
    @CurrentUser() user: User,
    @Query() query: QueryContactsDto,
  ): Promise<PaginatedContactsResponseDto> {
    const page = await this.contactsService.findAll(user.id, query);
    return { ...page, data: page.data.map((c) => ContactMapper.toDto(c)) };
  }

  @Get(':id')
  @ApiOkResponse({ type: ContactResponseDto })
  async findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContactResponseDto> {
    return ContactMapper.toDto(await this.contactsService.findOne(id, user.id));
  }

  @Patch(':id')
  @RequiresTier(Plan.PREMIUM)
  @ApiOkResponse({ type: ContactResponseDto })
  @ApiConflictResponse({ description: 'Já existe contato do usuário com este e-mail' })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContactDto,
  ): Promise<ContactResponseDto> {
    return ContactMapper.toDto(await this.contactsService.update(id, user.id, dto));
  }

  @Delete(':id')
  @RequiresTier(Plan.PREMIUM)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Contato tem splits e não pode ser removido' })
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.contactsService.remove(id, user.id);
  }
}
