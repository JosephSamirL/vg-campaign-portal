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
          {
            foreignKeyName: "app_users_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
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
            foreignKeyName: "campaigns_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "campaigns_parent_campaign_id_fkey"
            columns: ["parent_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_parent_campaign_id_fkey"
            columns: ["parent_campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_performance"
            referencedColumns: ["campaign_id"]
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
          {
            foreignKeyName: "contacts_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
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
            foreignKeyName: "events_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "events_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_performance"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "events_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      import_issues: {
        Row: {
          brand_id: string
          detail: Json | null
          id: number
          reason: string
          row_no: number | null
          run_id: string | null
          severity: Database["public"]["Enums"]["issue_severity"]
          source_file: string | null
        }
        Insert: {
          brand_id: string
          detail?: Json | null
          id?: never
          reason: string
          row_no?: number | null
          run_id?: string | null
          severity: Database["public"]["Enums"]["issue_severity"]
          source_file?: string | null
        }
        Update: {
          brand_id?: string
          detail?: Json | null
          id?: never
          reason?: string
          row_no?: number | null
          run_id?: string | null
          severity?: Database["public"]["Enums"]["issue_severity"]
          source_file?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_issues_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_issues_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "import_issues_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      import_runs: {
        Row: {
          brand_code: string | null
          brand_id: string
          entity: string | null
          finished_at: string | null
          id: string
          source_file: string | null
          started_at: string
          summary: Json | null
        }
        Insert: {
          brand_code?: string | null
          brand_id: string
          entity?: string | null
          finished_at?: string | null
          id: string
          source_file?: string | null
          started_at?: string
          summary?: Json | null
        }
        Update: {
          brand_code?: string | null
          brand_id?: string
          entity?: string | null
          finished_at?: string | null
          id?: string
          source_file?: string | null
          started_at?: string
          summary?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "import_runs_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_runs_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
        ]
      }
      metric_rules: {
        Row: {
          alternative_text: string
          key: string
          label: string
          rule_text: string
        }
        Insert: {
          alternative_text: string
          key: string
          label: string
          rule_text: string
        }
        Update: {
          alternative_text?: string
          key?: string
          label?: string
          rule_text?: string
        }
        Relationships: []
      }
      provider_batches: {
        Row: {
          batch_id: string
          brand_id: string
          created_at: string
          last_event_id: string | null
          last_ok_at: string | null
          last_polled_at: string | null
          next_cursor: string | null
          polling: string
          send_id: string
        }
        Insert: {
          batch_id: string
          brand_id: string
          created_at?: string
          last_event_id?: string | null
          last_ok_at?: string | null
          last_polled_at?: string | null
          next_cursor?: string | null
          polling?: string
          send_id: string
        }
        Update: {
          batch_id?: string
          brand_id?: string
          created_at?: string
          last_event_id?: string | null
          last_ok_at?: string | null
          last_polled_at?: string | null
          next_cursor?: string | null
          polling?: string
          send_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_batches_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_batches_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "provider_batches_send_id_fkey"
            columns: ["send_id"]
            isOneToOne: true
            referencedRelation: "sends"
            referencedColumns: ["id"]
          },
        ]
      }
      send_recipients: {
        Row: {
          address: string
          brand_id: string
          contact_id: string
          external_id: string
          send_id: string
        }
        Insert: {
          address: string
          brand_id: string
          contact_id: string
          external_id: string
          send_id: string
        }
        Update: {
          address?: string
          brand_id?: string
          contact_id?: string
          external_id?: string
          send_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_recipients_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_recipients_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "send_recipients_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_recipients_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_recipients_send_id_fkey"
            columns: ["send_id"]
            isOneToOne: false
            referencedRelation: "sends"
            referencedColumns: ["id"]
          },
        ]
      }
      sends: {
        Row: {
          accepted_count: number | null
          batch_id: string | null
          batch_key: string | null
          body_sha256: string | null
          brand_id: string
          campaign_id: string
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          dispatch_attempts: number
          dispatch_lease_until: string | null
          dispatched_at: string | null
          failure_reason: string | null
          id: string
          provider_responded_at: string | null
          recipient_count: number
          rejected_count: number | null
          source: Database["public"]["Enums"]["send_source"]
          status: Database["public"]["Enums"]["send_status"]
        }
        Insert: {
          accepted_count?: number | null
          batch_id?: string | null
          batch_key?: string | null
          body_sha256?: string | null
          brand_id: string
          campaign_id: string
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          dispatch_attempts?: number
          dispatch_lease_until?: string | null
          dispatched_at?: string | null
          failure_reason?: string | null
          id?: string
          provider_responded_at?: string | null
          recipient_count: number
          rejected_count?: number | null
          source: Database["public"]["Enums"]["send_source"]
          status?: Database["public"]["Enums"]["send_status"]
        }
        Update: {
          accepted_count?: number | null
          batch_id?: string | null
          batch_key?: string | null
          body_sha256?: string | null
          brand_id?: string
          campaign_id?: string
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          dispatch_attempts?: number
          dispatch_lease_until?: string | null
          dispatched_at?: string | null
          failure_reason?: string | null
          id?: string
          provider_responded_at?: string | null
          recipient_count?: number
          rejected_count?: number | null
          source?: Database["public"]["Enums"]["send_source"]
          status?: Database["public"]["Enums"]["send_status"]
        }
        Relationships: [
          {
            foreignKeyName: "sends_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sends_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_performance"
            referencedColumns: ["campaign_id"]
          },
        ]
      }
    }
    Views: {
      v_campaign_performance: {
        Row: {
          bounce_rate: number | null
          bounced: number | null
          brand_id: string | null
          campaign_id: string | null
          channel: string | null
          click_rate: number | null
          clicks: number | null
          delivered: number | null
          delivered_rate: number | null
          external_id: string | null
          name: string | null
          open_rate: number | null
          opens: number | null
          send_id: string | null
          sent: number | null
          sent_at: string | null
          source: string | null
          spend: number | null
          target_country: string | null
          unsubscribe_rate: number | null
          unsubscribes: number | null
        }
        Insert: {
          bounce_rate?: never
          bounced?: number | null
          brand_id?: string | null
          campaign_id?: string | null
          channel?: string | null
          click_rate?: never
          clicks?: number | null
          delivered?: number | null
          delivered_rate?: never
          external_id?: string | null
          name?: string | null
          open_rate?: never
          opens?: number | null
          send_id?: never
          sent?: number | null
          sent_at?: string | null
          source?: never
          spend?: number | null
          target_country?: string | null
          unsubscribe_rate?: never
          unsubscribes?: never
        }
        Update: {
          bounce_rate?: never
          bounced?: number | null
          brand_id?: string | null
          campaign_id?: string | null
          channel?: string | null
          click_rate?: never
          clicks?: number | null
          delivered?: number | null
          delivered_rate?: never
          external_id?: string | null
          name?: string | null
          open_rate?: never
          opens?: number | null
          send_id?: never
          sent?: number | null
          sent_at?: string | null
          source?: never
          spend?: number | null
          target_country?: string | null
          unsubscribe_rate?: never
          unsubscribes?: never
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
            foreignKeyName: "campaigns_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
        ]
      }
      v_contacts: {
        Row: {
          brand_id: string | null
          city: string | null
          consent_marketing: boolean | null
          contactable: boolean | null
          country: string | null
          email: string | null
          external_id: string | null
          full_name: string | null
          id: string | null
          phone: string | null
          signup_at: string | null
          status: string | null
          suppressed_at: string | null
          suppressed_reason: string | null
          suppressed_until: string | null
        }
        Insert: {
          brand_id?: string | null
          city?: string | null
          consent_marketing?: boolean | null
          contactable?: never
          country?: string | null
          email?: string | null
          external_id?: string | null
          full_name?: string | null
          id?: string | null
          phone?: string | null
          signup_at?: string | null
          status?: string | null
          suppressed_at?: string | null
          suppressed_reason?: string | null
          suppressed_until?: string | null
        }
        Update: {
          brand_id?: string | null
          city?: string | null
          consent_marketing?: boolean | null
          contactable?: never
          country?: string | null
          email?: string | null
          external_id?: string | null
          full_name?: string | null
          id?: string | null
          phone?: string | null
          signup_at?: string | null
          status?: string | null
          suppressed_at?: string | null
          suppressed_reason?: string | null
          suppressed_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
        ]
      }
      v_dashboard_totals: {
        Row: {
          brand_id: string | null
          contactable: number | null
          total_customers: number | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
        ]
      }
      v_import_issue_groups: {
        Row: {
          brand_id: string | null
          n: number | null
          reason: string | null
          run_id: string | null
          severity: Database["public"]["Enums"]["issue_severity"] | null
        }
        Relationships: [
          {
            foreignKeyName: "import_issues_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_issues_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "v_signups_30d"
            referencedColumns: ["brand_id"]
          },
          {
            foreignKeyName: "import_issues_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      v_signups_30d: {
        Row: {
          brand_id: string | null
          day: string | null
          future_dated_count: number | null
          signups: number | null
          window_end: string | null
          window_start: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      confirm_send: {
        Args: { p_campaign_id: string; p_expected_count: number }
        Returns: {
          accepted_count: number | null
          batch_id: string | null
          batch_key: string | null
          body_sha256: string | null
          brand_id: string
          campaign_id: string
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          dispatch_attempts: number
          dispatch_lease_until: string | null
          dispatched_at: string | null
          failure_reason: string | null
          id: string
          provider_responded_at: string | null
          recipient_count: number
          rejected_count: number | null
          source: Database["public"]["Enums"]["send_source"]
          status: Database["public"]["Enums"]["send_status"]
        }
        SetofOptions: {
          from: "*"
          to: "sends"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_app_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      current_brand_id: { Args: never; Returns: string }
      is_contactable: {
        Args: { c: Database["public"]["Tables"]["contacts"]["Row"] }
        Returns: boolean
      }
      normalize_event_type: {
        Args: { p: string }
        Returns: Database["public"]["Enums"]["event_type"]
      }
      recipient_preview: {
        Args: { p_campaign_id: string }
        Returns: {
          channel: string
          country_mismatch_or_unknown: number
          no_address: number
          not_contactable: number
          rule_text: string
          target_country: string
          total_count: number
        }[]
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
      issue_severity: "reject" | "warn" | "route"
      send_source: "portal" | "seed_send_log"
      send_status:
        | "pending"
        | "confirmed"
        | "dispatched"
        | "reporting"
        | "complete"
        | "partial"
        | "failed"
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
      issue_severity: ["reject", "warn", "route"],
      send_source: ["portal", "seed_send_log"],
      send_status: [
        "pending",
        "confirmed",
        "dispatched",
        "reporting",
        "complete",
        "partial",
        "failed",
      ],
    },
  },
} as const

