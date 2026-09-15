export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_users: {
        Row: {
          auth_user_id: string | null
          brand_id: string
          email: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          auth_user_id?: string | null
          brand_id: string
          email: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          auth_user_id?: string | null
          brand_id?: string
          email?: string
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: [
          {
            foreignKeyName: "app_users_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
        ]
      }
      brands: {
        Row: {
          code: string
          id: string
          name: string
        }
        Insert: {
          code: string
          id?: string
          name: string
        }
        Update: {
          code?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      campaigns: {
        Row: {
          as_of: string
          brand_id: string
          channel: string | null
          created_at: string
          external_id: string
          file_rank: number
          id: string
          name: string | null
          parent_campaign_id: string | null
          parent_external_id: string | null
          reported_bounced: number | null
          reported_clicks: number | null
          reported_delivered: number | null
          reported_opens: number | null
          reported_sent: number | null
          send_local_time: string | null
          sent_at: string | null
          spend: number | null
          target_country: string | null
          updated_at: string
        }
        Insert: {
          as_of?: string
          brand_id: string
          channel?: string | null
          created_at?: string
          external_id: string
          file_rank?: number
          id?: string
          name?: string | null
          parent_campaign_id?: string | null
          parent_external_id?: string | null
          reported_bounced?: number | null
          reported_clicks?: number | null
          reported_delivered?: number | null
          reported_opens?: number | null
          reported_sent?: number | null
          send_local_time?: string | null
          sent_at?: string | null
          spend?: number | null
          target_country?: string | null
          updated_at?: string
        }
        Update: {
          as_of?: string
          brand_id?: string
          channel?: string | null
          created_at?: string
          external_id?: string
          file_rank?: number
          id?: string
          name?: string | null
          parent_campaign_id?: string | null
          parent_external_id?: string | null
          reported_bounced?: number | null
          reported_clicks?: number | null
          reported_delivered?: number | null
          reported_opens?: number | null
          reported_sent?: number | null
          send_local_time?: string | null
          sent_at?: string | null
          spend?: number | null
          target_country?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_parent_campaign_id_fkey"
            columns: ["parent_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          as_of: string
          brand_id: string
          city: string | null
          consent_marketing: boolean | null
          country: string | null
          created_at: string
          deleted_at: string | null
          email: string | null
          external_id: string
          file_rank: number
          full_name: string | null
          id: string
          notes: string | null
          phone: string | null
          routed_from: string | null
          signup_at: string | null
          status: string | null
          suppressed_at: string | null
          suppressed_reason: string | null
          suppressed_until: string | null
          updated_at: string
        }
        Insert: {
          as_of?: string
          brand_id: string
          city?: string | null
          consent_marketing?: boolean | null
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          external_id: string
          file_rank?: number
          full_name?: string | null
          id?: string
          notes?: string | null
          phone?: string | null
          routed_from?: string | null
          signup_at?: string | null
          status?: string | null
          suppressed_at?: string | null
          suppressed_reason?: string | null
          suppressed_until?: string | null
          updated_at?: string
        }
        Update: {
          as_of?: string
          brand_id?: string
          city?: string | null
          consent_marketing?: boolean | null
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          external_id?: string
          file_rank?: number
          full_name?: string | null
          id?: string
          notes?: string | null
          phone?: string | null
          routed_from?: string | null
          signup_at?: string | null
          status?: string | null
          suppressed_at?: string | null
          suppressed_reason?: string | null
          suppressed_until?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          batch_id: string | null
          brand_id: string
          campaign_id: string | null
          channel: string | null
          contact_id: string | null
          created_at: string
          event_id: string
          id: number
          occurred_at: string | null
          raw: Json | null
          send_id: string | null
          source: Database["public"]["Enums"]["event_source"]
          type: Database["public"]["Enums"]["event_type"]
        }
        Insert: {
          batch_id?: string | null
          brand_id: string
          campaign_id?: string | null
          channel?: string | null
          contact_id?: string | null
          created_at?: string
          event_id: string
          id?: never
          occurred_at?: string | null
          raw?: Json | null
          send_id?: string | null
          source: Database["public"]["Enums"]["event_source"]
          type: Database["public"]["Enums"]["event_type"]
        }
        Update: {
          batch_id?: string | null
          brand_id?: string
          campaign_id?: string | null
          channel?: string | null
          contact_id?: string | null
          created_at?: string
          event_id?: string
          id?: never
          occurred_at?: string | null
          raw?: Json | null
          send_id?: string | null
          source?: Database["public"]["Enums"]["event_source"]
          type?: Database["public"]["Enums"]["event_type"]
        }
        Relationships: [
          {
            foreignKeyName: "events_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_app_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      current_brand_id: { Args: never; Returns: string }
      normalize_event_type: {
        Args: { p: string }
        Returns: Database["public"]["Enums"]["event_type"]
      }
    }
    Enums: {
      app_role: "owner" | "analyst"
      event_source: "seed" | "provider"
      event_type:
        | "delivered"
        | "bounced"
        | "opened"
        | "clicked"
        | "unsubscribed"
        | "complained"
        | "unknown"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["owner", "analyst"],
      event_source: ["seed", "provider"],
      event_type: [
        "delivered",
        "bounced",
        "opened",
        "clicked",
        "unsubscribed",
        "complained",
        "unknown",
      ],
    },
  },
} as const

