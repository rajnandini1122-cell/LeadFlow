import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ListConversationsDto {
  @ApiProperty({ description: 'The lead whose conversations to return.' })
  @IsUUID()
  leadId!: string;
}

export class LinkConversationDto {
  @ApiProperty({ description: 'The existing lead to attach this conversation to.' })
  @IsUUID()
  leadId!: string;
}
